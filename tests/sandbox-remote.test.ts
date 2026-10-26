/**
 * sandbox-remote.test.ts — host ⇄ sandboxd（mTLS）⇄ supervisor 端到端测试
 *
 * sandboxd 使用 ProcessLauncher 在本机运行（无容器隔离），验证协议、握手、skills 分发、
 * 生命周期与认证。容器隔离由部署层（docker + gVisor + VM 防火墙）提供，见 docs/sandbox-remote.md。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Sandboxd } from "../src/sandbox/remote/sandboxd.js";
import { parseSandboxdConfig } from "../src/sandbox/remote/sandboxd-config.js";
import { Sandbox, type SandboxRuntimeConfig } from "../src/sandbox/sandbox.js";
import { invalidateSkillsGeneration } from "../src/sandbox/skills/skills-sync.js";
import { buildSandboxRuntime } from "../src/sandbox/runtime-config.js";
import { openRemoteSession, remoteControlRequest, RemoteSessionError } from "../src/sandbox/transport/remote-transport.js";
import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";
import { loadConfig } from "../src/core/config.js";

const CHAT = "telegram:-4242";

let dir = "";
let certs: Record<string, string> = {};
let daemon: Sandboxd;
let port = 0;
let skillsDir = "";
const sandboxes: Sandbox[] = [];

function openssl(args: string[]): void {
    const res = spawnSync("openssl", args, { cwd: dir, encoding: "utf-8" });
    if (res.status !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${res.stderr}`);
}

function genCerts(): void {
    openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", "ca.key"]);
    openssl(["req", "-x509", "-new", "-key", "ca.key", "-days", "2", "-subj", "/CN=test-ca", "-out", "ca.crt"]);
    const issue = (name: string, ext: string) => {
        openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", `${name}.key`]);
        openssl(["req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`]);
        writeFileSync(join(dir, `${name}.ext`), ext);
        openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", `${name}.ext`, "-out", `${name}.crt`]);
    };
    issue("server", "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
    issue("client", "extendedKeyUsage=clientAuth\n");
    issue("intruder", "extendedKeyUsage=clientAuth\n");
    certs = Object.fromEntries(["ca.crt", "server.crt", "server.key", "client.crt", "client.key", "intruder.crt", "intruder.key"].map((f) => [f, join(dir, f)]));
}

function fingerprint(certPath: string): string {
    return new X509Certificate(readFileSync(certPath)).fingerprint256;
}

function runtimeFor(clientCert = certs["client.crt"], clientKey = certs["client.key"]): SandboxRuntimeConfig {
    return buildSandboxRuntime({
        mode: "remote",
        inheritHostEnv: false,
        skillsSyncBack: false,
        processExec: true,
        readyTimeoutMs: 30_000,
        remote: {
            endpoints: [{ name: "local", address: `127.0.0.1:${port}`, servername: "localhost" }],
            tls: { ca: certs["ca.crt"], cert: clientCert, key: clientKey },
            connectTimeoutMs: 5_000,
            pingIntervalMs: 2_000,
        },
    }, skillsDir);
}

async function makeSandbox(chatId = CHAT, handler?: (method: string, args: unknown[]) => Promise<unknown>): Promise<Sandbox> {
    const sb = new Sandbox(undefined, chatId, { SANDBOX_VISIBLE: "yes" }, [], runtimeFor());
    sb.setHostCallHandler(async (method, args) => {
        if (method === "mcp.list") return [];
        if (handler) return handler(method, args);
        throw new Error(`unexpected ${method}`);
    });
    sandboxes.push(sb);
    await sb.start();
    return sb;
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
            setTimeout(tick, 50);
        };
        tick();
    });
}

before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cgm-sandbox-remote-"));
    genCerts();
    skillsDir = join(dir, "host-skills");
    mkdirSync(join(skillsDir, "hello"), { recursive: true });
    writeFileSync(join(skillsDir, "hello", "index.ts"), `export function greet(name: string) { return "hello " + name; }\n`);
    writeFileSync(join(skillsDir, "hello", "hello.d.ts"), `/** greet */\nexport declare function greet(name: string): string;\n`);
    invalidateSkillsGeneration();
    process.env.HOST_ONLY_SECRET = "must-not-leak";

    const cfg = parseSandboxdConfig({
        listen: { host: "127.0.0.1", port: 0 },
        tls: {
            ca: certs["ca.crt"],
            cert: certs["server.crt"],
            key: certs["server.key"],
            allowed_client_fingerprints: [fingerprint(certs["client.crt"])],
        },
        data_dir: join(dir, "sandboxd-data"),
        launcher: "process",
        max_sessions: 3,
        host_idle_kill_ms: 5_000,
    });
    daemon = new Sandboxd(cfg);
    const addr = await daemon.listen();
    port = addr.port!;
});

after(async () => {
    // inbox 中只有本测试拉取的临时文件
    rmSync(join(process.cwd(), "workspace", ".sandbox-inbox", createHash("sha256").update("telegram:-9001").digest("hex").slice(0, 32)), { recursive: true, force: true });
    for (const sb of sandboxes) await sb.stop().catch(() => undefined);
    await daemon?.close();
    delete process.env.HOST_ONLY_SECRET;
    rmSync(dir, { recursive: true, force: true });
});

describe("remote sandbox over mTLS", () => {
    it("executes JS and bash in the remote session with an isolated home and no host env", async () => {
        const sb = await makeSandbox();
        assert.ok(sb.isRemote());
        assert.ok(sb.getSandboxHome().startsWith(join(dir, "sandboxd-data", "homes")), sb.getSandboxHome());

        const js = await sb.execute(`console.log(JSON.stringify({
            secret: process.env.HOST_ONLY_SECRET ?? null,
            visible: process.env.SANDBOX_VISIBLE ?? null,
            noNet: process.env.SANDBOX_NO_NETWORK ?? null,
            cwd: process.cwd(),
        }))`);
        assert.equal(js.error, false, js.output);
        const info = JSON.parse(js.output.split("\n").find((l) => l.startsWith("{"))!);
        assert.equal(info.secret, null);
        assert.equal(info.visible, "yes");
        assert.equal(info.noNet, "1");
        assert.equal(info.cwd, sb.getSandboxHome());

        const sh = await sb.executeShell(`echo "home=$HOME" && echo "secret=\${HOST_ONLY_SECRET:-none}"`);
        assert.equal(sh.error, false, sh.output);
        assert.match(sh.output, new RegExp(`home=${sb.getSandboxHome().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(sh.output, /secret=none/);

        const blocked = await sb.executeShell("pip install requests");
        assert.equal(blocked.error, true);
        assert.match(blocked.output, /没有网络访问/);
    });

    it("bridges host_calls and shell background wakes", async () => {
        const calls: string[] = [];
        const sb = await makeSandbox("telegram:-4243", async (method) => {
            calls.push(method);
            return [{ fact: "remote ok" }];
        });
        const res = await sb.execute(`const r = await memory.searchFacts("x"); console.log(JSON.stringify(r));`);
        assert.equal(res.error, false, res.output);
        assert.match(res.output, /remote ok/);
        assert.ok(calls.includes("memory.searchFacts"));

        const wake = new Promise<{ reason: string; exitCode?: number }>((resolve) => sb.once("shell_wake", resolve));
        await sb.runShellBackground("sleep 1; echo BG_DONE", { idleTimeout: 0 });
        assert.equal(sb.hasActiveBackgroundTasks(), true);
        const event = await wake;
        assert.equal(event.reason, "exit");
        assert.equal(event.exitCode, 0);
        assert.equal(sb.hasActiveBackgroundTasks(), false);
        const tabs = await sb.listShellTabs();
        assert.ok(tabs.some((t) => t.id === "default"));
    });

    it("transfers files in chunks and confines paths to the sandbox home", async () => {
        const sb = await makeSandbox("telegram:-4244");
        const big = Buffer.alloc(2_500_000, 7);
        await sb.writeFileChunk("Downloads/blob.bin", big.subarray(0, 1_000_000), false);
        await sb.writeFileChunk("Downloads/blob.bin", big.subarray(1_000_000), true);
        const st = await sb.statFile("Downloads/blob.bin");
        assert.equal(st?.size, big.length);
        let offset = 0;
        const parts: Buffer[] = [];
        for (;;) {
            const chunk = await sb.readFileChunk("Downloads/blob.bin", offset, 1024 * 1024);
            parts.push(chunk.data);
            offset += chunk.data.length;
            if (chunk.eof) break;
        }
        assert.ok(Buffer.concat(parts).equals(big));
        assert.equal(await sb.statFile("../../../../etc/passwd"), null);
        await assert.rejects(sb.writeFileChunk("/etc/evil", Buffer.from("x"), false), /outside sandbox home/);
    });

    it("ships host skills once per generation and loads them in the sandbox", async () => {
        for (const prev of sandboxes.splice(0)) await prev.stop().catch(() => undefined);
        await waitFor(() => daemon.activeSessionCount === 0);
        const sb = await makeSandbox("telegram:-4245");
        const res = await sb.execute(`console.log(hello.greet("remote"))`);
        assert.equal(res.error, false, res.output);
        assert.match(res.output, /hello remote/);
        const generations = readdirSafe(join(dir, "sandboxd-data", "skills")).filter((n) => /^[a-f0-9]{16,64}$/.test(n));
        assert.equal(generations.length, 1);
        await sb.stop();
    });

    it("answers health and logs control requests", async () => {
        const transport = {
            endpoints: [{ name: "local", address: `127.0.0.1:${port}`, servername: "localhost" }],
            tls: { ca: certs["ca.crt"], cert: certs["client.crt"], key: certs["client.key"] },
            connectTimeoutMs: 5_000,
        };
        daemon.recordLog("test-log-line");
        const health = await remoteControlRequest(transport, transport.endpoints[0], { type: "health" });
        assert.equal(health.type, "health_result");
        assert.equal(health.maxSessions, 3);
        assert.equal(typeof health.sessions, "number");
        const logs = await remoteControlRequest(transport, transport.endpoints[0], { type: "logs_tail", since: 0 });
        assert.ok((logs.lines as Array<{ line: string }>).some((l) => l.line === "test-log-line"));
    });

    it("rejects clients whose certificate is not allowlisted", async () => {
        await assert.rejects(
            openRemoteSession(
                {
                    endpoints: [{ name: "local", address: `127.0.0.1:${port}`, servername: "localhost" }],
                    tls: { ca: certs["ca.crt"], cert: certs["intruder.crt"], key: certs["intruder.key"] },
                    connectTimeoutMs: 5_000,
                },
                { chatId: "telegram:-1", env: {}, shellPath: "/usr/bin:/bin", skillsHash: null },
                { packSkills: () => { throw new Error("unused"); } },
            ),
            (err: unknown) => err instanceof RemoteSessionError && (err.code === "auth" || err.code === "closed"),
        );
    });

    it("kills the session when the host disconnects and enforces capacity", async () => {
        for (const sb of sandboxes.splice(0)) await sb.stop().catch(() => undefined);
        await waitFor(() => daemon.activeSessionCount === 0);

        const a = await makeSandbox("telegram:-5001");
        const b = await makeSandbox("telegram:-5002");
        const c = await makeSandbox("telegram:-5003");
        assert.equal(daemon.activeSessionCount, 3);
        await assert.rejects(makeSandbox("telegram:-5004"), /capacity/);

        await a.stop();
        await waitFor(() => daemon.activeSessionCount === 2);
        assert.equal(b.isAlive() && c.isAlive(), true);
    });

    it("kills the session when the host goes silent", async () => {
        for (const sb of sandboxes.splice(0)) await sb.stop().catch(() => undefined);
        await waitFor(() => daemon.activeSessionCount === 0);
        const sb = await makeSandbox("telegram:-6001");
        const internals = sb as unknown as { pingTimer: ReturnType<typeof setInterval> | null };
        if (internals.pingTimer) clearInterval(internals.pingTimer);
        internals.pingTimer = null;
        const exited = new Promise<void>((resolve) => sb.once("exit", () => resolve()));
        await exited;
        assert.equal(sb.isAlive(), false);
    });

    it("terminates the session on an oversized frame from the sandbox", async () => {
        const sb = await makeSandbox("telegram:-7001");
        const exited = new Promise<void>((resolve) => sb.once("exit", () => resolve()));
        await sb.execute(`process.stdout.write("y".repeat(5 * 1024 * 1024))`, 30_000).catch(() => undefined);
        await exited;
        assert.equal(sb.isAlive(), false);
    });

    it("does not count slow session provisioning (e.g. VM boot) against the ready timeout", async () => {
        const base = runtimeFor();
        const remote = base.remote!;
        // 就绪超时 8s（+2s 余量）；openSession 模拟 11s 的 VM 开机。计时若包含开机耗时就会失败
        const runtime: SandboxRuntimeConfig = {
            ...base,
            readyTimeoutMs: 8_000,
            remote: {
                ...remote,
                openSession: async (open) => {
                    await new Promise((r) => setTimeout(r, 11_000));
                    return remote.openSession(open);
                },
            },
        };
        const sb = new Sandbox(undefined, "telegram:-9101", {}, [], runtime);
        sandboxes.push(sb);
        await sb.start();
        assert.equal(sb.isAlive(), true);
    });

    it("stop() waits for the remote release (e.g. deleting the ephemeral VM) to finish", async () => {
        const base = runtimeFor();
        const remote = base.remote!;
        let released = false;
        const runtime: SandboxRuntimeConfig = {
            ...base,
            remote: {
                ...remote,
                openSession: async (open) => ({
                    ...(await remote.openSession(open)),
                    release: () => new Promise<void>((resolve) => setTimeout(() => { released = true; resolve(); }, 1_000)),
                }),
            },
        };
        const sb = new Sandbox(undefined, "telegram:-9201", {}, [], runtime);
        sandboxes.push(sb);
        await sb.start();
        await sb.stop();
        assert.equal(released, true, "release must complete before stop() resolves");
    });

    it("routes sandbox files to adapters through the host inbox and blocks host files", async () => {
        for (const prev of sandboxes.splice(0)) await prev.stop().catch(() => undefined);
        await waitFor(() => daemon.activeSessionCount === 0);
        const received: Array<{ method: string; args: unknown[] }> = [];
        const sb = new Sandbox(undefined, "telegram:-9001", {}, [], runtimeFor());
        sb.setHostCallHandler(createSandboxHostCallHandler("telegram:-9001", {
            appConfig: loadConfig("does-not-exist.yaml", true),
            globalState: {},
            accumulator: {},
            memory: { getGroupModel: () => null },
            adapters: [{
                platform: "telegram",
                canHandle: (m: string) => m.startsWith("telegram."),
                getWriteMethods: () => ["telegram.sendFile", "telegram.sendText"],
                handleCall: async (method: string, args: unknown[]) => {
                    received.push({ method, args });
                    return { id: 1 };
                },
            }],
            sandbox: sb,
            sandboxPool: {},
            mcpBridge: { list: () => [] },
            buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
            getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
            setCurrentEnvPlan: () => undefined,
            applyHostManagedEnv: () => undefined,
        } as any));
        sandboxes.push(sb);
        await sb.start();

        const ok = await sb.execute(`
            fs.writeFile("media/report.txt", "made in sandbox");
            await telegram.sendFile("-9001", "media/report.txt");
            console.log("sent");
        `, 30_000);
        assert.equal(ok.error, false, ok.output);
        assert.equal(received.length, 1);
        const hostPath = String(received[0].args[1]);
        assert.ok(hostPath.includes(".sandbox-inbox"), hostPath);
        assert.equal(readFileSync(hostPath, "utf-8"), "made in sandbox");

        writeFileSync(join(process.cwd(), "host-secret-for-test.txt"), "secret");
        try {
            const blocked = await sb.execute(`await telegram.sendFile("-9001", ${JSON.stringify(join(process.cwd(), "host-secret-for-test.txt"))});`, 30_000);
            assert.equal(blocked.error, true);
            assert.match(blocked.output, /不能引用宿主文件/);
            assert.equal(received.length, 1);
        } finally {
            rmSync(join(process.cwd(), "host-secret-for-test.txt"), { force: true });
        }
    });

    it("persists the chat home across sessions", async () => {
        const first = await makeSandbox("telegram:-8001");
        await first.executeShell("echo persisted > note.txt");
        const home = first.getSandboxHome();
        await first.stop();
        const second = await makeSandbox("telegram:-8001");
        assert.equal(second.getSandboxHome(), home);
        const res = await second.executeShell("cat note.txt");
        assert.match(res.output, /persisted/);
        const chatKey = createHash("sha256").update("telegram:-8001").digest("hex").slice(0, 32);
        assert.ok(home.endsWith(chatKey));
        assert.ok(existsSync(join(home, ".last_used")));
    });
});

function readdirSafe(p: string): string[] {
    try {
        return readdirSync(p);
    } catch {
        return [];
    }
}

/**
 * 真实容器隔离测试（需要 docker 与已构建的 session 镜像）：
 *   docker build -f Dockerfile.sandbox --target session -t cgm-sandbox-test .
 *   SANDBOX_TEST_DOCKER=1 SANDBOX_TEST_IMAGE=cgm-sandbox-test SANDBOX_TEST_RUNTIME=runsc pnpm test:sandbox
 */
describe("docker launcher isolation", { skip: !process.env.SANDBOX_TEST_DOCKER }, () => {
    let dockerDaemon: Sandboxd;
    let dockerPort = 0;
    const dockerSandboxes: Sandbox[] = [];

    before(async () => {
        const cfg = parseSandboxdConfig({
            listen: { host: "127.0.0.1", port: 0 },
            tls: { ca: certs["ca.crt"], cert: certs["server.crt"], key: certs["server.key"] },
            data_dir: join(dir, "docker-data"),
            launcher: "docker",
            docker: {
                image: process.env.SANDBOX_TEST_IMAGE ?? "cgm-sandbox-test",
                runtime: process.env.SANDBOX_TEST_RUNTIME ?? "",
            },
            home_owner: { uid: 1000, gid: 1000 },
        });
        dockerDaemon = new Sandboxd(cfg);
        dockerPort = (await dockerDaemon.listen()).port!;
    });

    after(async () => {
        for (const sb of dockerSandboxes) await sb.stop().catch(() => undefined);
        await dockerDaemon?.close();
    });

    it("runs agent code with no network, no root, read-only rootfs and no host env", async () => {
        const runtime = buildSandboxRuntime({
            mode: "remote",
            inheritHostEnv: false,
            skillsSyncBack: false,
            readyTimeoutMs: 60_000,
            remote: {
                endpoints: [{ name: "docker", address: `127.0.0.1:${dockerPort}`, servername: "localhost" }],
                tls: { ca: certs["ca.crt"], cert: certs["client.crt"], key: certs["client.key"] },
                connectTimeoutMs: 5_000,
                pingIntervalMs: 5_000,
            },
        }, skillsDir);
        const sb = new Sandbox(undefined, "telegram:-10001", {}, [], runtime);
        sb.setHostCallHandler(async (m) => (m === "mcp.list" ? [] : null));
        dockerSandboxes.push(sb);
        await sb.start();
        assert.equal(sb.getSandboxHome(), "/home/agent");
        const res = await sb.execute(`
            let net = "blocked";
            try { await fetch("http://169.254.169.254/", { signal: AbortSignal.timeout(3000) }); net = "open"; } catch {}
            let rootfs = "ro";
            try { fs.writeFile("/usr/x", "x"); rootfs = "rw"; } catch {}
            try { require("node:fs").writeFileSync("/usr/x", "x"); rootfs = "rw"; } catch {}
            console.log(JSON.stringify({ net, rootfs, uid: process.getuid(), secret: process.env.HOST_ONLY_SECRET ?? null }));
        `, 30_000);
        const info = JSON.parse(res.output.split("\n").find((l) => l.startsWith("{"))!);
        assert.equal(info.net, "blocked");
        assert.equal(info.rootfs, "ro");
        assert.equal(info.uid, 1000);
        assert.equal(info.secret, null);
        const sh = await sb.executeShell("cat /proc/net/route | wc -l; ls /home");
        assert.doesNotMatch(sh.output, /eth0/);
    });
});
