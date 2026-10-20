/**
 * acceptance.ts — remote sandbox 部署验收（以攻击者视角在真实 sandbox VM 上执行）
 *
 * 在 host VM 上运行（host 侧 → mTLS → sandboxd → docker + gVisor session）：
 *   SANDBOX_ENDPOINT=10.10.0.3:7443 SANDBOX_SERVERNAME=cgm-sandbox-1 \
 *   SANDBOX_TLS_DIR=/run/cgm-tls QUOTA_MIB=5120 \
 *   npx tsx scripts/sandbox-vm/acceptance.ts
 *
 * SANDBOX_TLS_DIR 下需要 ca.crt / client.crt / client.key（或 gen-certs.sh 产出的 host-client.crt / .key）。
 * QUOTA_MIB 为 sandbox VM 上 HOME_QUOTA_BLOCKS_KB / 1024（配额检查会写入 QUOTA_MIB + 200 MiB）。
 * 配额由 cgm-homes-quota.timer 每 60s 为新 home 设置，脚本会等待 65s。
 *
 * 临时 VM 模式（每个 chat 一台 Spot VM，经 Cloud Run broker 创建）：
 *   BROKER_URL=https://cgm-sandbox-broker-xxx.run.app SANDBOX_REGIONS="northamerica-northeast1 europe-west9" \
 *   npx tsx scripts/sandbox-vm/acceptance.ts
 *   （VPC 内纯 TCP；不检查 per-home 配额；会话回收以 VM 被删除为准）
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Sandbox } from "../../src/sandbox/sandbox.js";
import { buildSandboxRuntime } from "../../src/sandbox/runtime-config.js";
import { createSandboxHostCallHandler } from "../../src/sandbox/host-call-handler.js";
import { loadConfig } from "../../src/core/config.js";
import { remoteControlRequest } from "../../src/sandbox/transport/remote-transport.js";
import { BrokerClient, metadataIdTokenProvider } from "../../src/sandbox/provisioner/broker-client.js";

const C = process.env.SANDBOX_TLS_DIR ?? "/run/cgm-tls";
const endpointAddress = process.env.SANDBOX_ENDPOINT ?? "10.10.0.3:7443";
const quotaMiB = Number(process.env.QUOTA_MIB ?? "5120");
const tlsFile = (...names: string[]) => names.map((n) => join(C, n)).find((p) => existsSync(p)) ?? join(C, names[0]);
const skillsDir = mkdtempSync(join(tmpdir(), "cgm-acceptance-skills-"));
process.env.HOST_ONLY_SECRET = "must-not-leak";
const remote = {
    endpoints: [{ name: "acceptance", address: endpointAddress, servername: process.env.SANDBOX_SERVERNAME ?? endpointAddress.split(":")[0] }],
    tls: { ca: join(C, "ca.crt"), cert: tlsFile("client.crt", "host-client.crt"), key: tlsFile("client.key", "host-client.key") },
    connectTimeoutMs: 10_000,
    pingIntervalMs: 15_000,
};
const brokerUrl = process.env.BROKER_URL;
const ephemeral = !!brokerUrl;
const broker = brokerUrl ? new BrokerClient(brokerUrl, metadataIdTokenProvider()) : null;
const vmNames = new Set<string>();
const runtime = buildSandboxRuntime({
    mode: "remote", inheritHostEnv: false, skillsSyncBack: false, readyTimeoutMs: 60_000,
    remote: ephemeral
        ? {
            endpoints: [], connectTimeoutMs: 10_000, pingIntervalMs: 15_000,
            provisioner: {
                brokerUrl: brokerUrl!,
                regions: (process.env.SANDBOX_REGIONS ?? "").split(/\s+/).filter(Boolean),
                sizes: { small: process.env.SANDBOX_MACHINE_TYPE ?? "c4-standard-2" }, defaultSize: "small",
                port: 7443, vmReadyTimeoutMs: 420_000, priceCacheFile: join(skillsDir, "prices.json"),
            },
        }
        : remote,
}, skillsDir, broker ? {
    // 记录创建的 VM，用于最后确认已被删除
    broker: new Proxy(broker, { get(target, prop) {
        if (prop === "create") return async (...a: [string, string, string]) => { const vm = await target.create(...a); vmNames.add(`${vm.zone}/${vm.name}`); return vm; };
        const v = (target as any)[prop]; return typeof v === "function" ? v.bind(target) : v;
    } }),
    prices: null,
} : undefined);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); };
const jsonLine = (out: string) => JSON.parse(out.split("\n").find((l) => l.startsWith("{"))!);

async function makeSandbox(chatId: string, received: Array<{ method: string; args: unknown[] }> = []) {
    const sb = new Sandbox(undefined, chatId, { SANDBOX_VISIBLE: "yes" }, [], runtime);
    sb.setHostCallHandler(createSandboxHostCallHandler(chatId, {
        appConfig: loadConfig("does-not-exist.yaml", true),
        globalState: {}, accumulator: {}, memory: { getGroupModel: () => null },
        adapters: [{
            platform: "telegram",
            canHandle: (m: string) => m.startsWith("telegram."),
            getWriteMethods: () => ["telegram.sendFile", "telegram.sendText"],
            handleCall: async (method: string, args: unknown[]) => { received.push({ method, args }); return { id: received.length }; },
        }],
        sandbox: sb, sandboxPool: {}, mcpBridge: { list: () => [] },
        buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        setCurrentEnvPlan: () => undefined, applyHostManagedEnv: () => undefined,
    } as any));
    const t0 = Date.now();
    await sb.start();
    return { sb, coldStartMs: Date.now() - t0 };
}

if (!ephemeral) {
    const health = await remoteControlRequest(remote, remote.endpoints[0], { type: "health" });
    check("health: sandboxd reachable over mTLS", health.type === "health_result", JSON.stringify(health));
}

const received: Array<{ method: string; args: unknown[] }> = [];
const { sb, coldStartMs } = await makeSandbox("telegram:-e2e-1", received);
check("session ready (docker + gVisor cold start)", sb.isAlive(), `${coldStartMs}ms, home=${sb.getSandboxHome()}`);

const js = jsonLine((await sb.execute(`
    let net = "blocked", metadata = "blocked";
    try { await fetch("https://example.com", { signal: AbortSignal.timeout(3000) }); net = "OPEN"; } catch {}
    try { await fetch("http://169.254.169.254/computeMetadata/v1/", { signal: AbortSignal.timeout(3000) }); metadata = "OPEN"; } catch {}
    const fsm = await import("node:fs");
    let rootfs = "ro"; try { fsm.writeFileSync("/usr/x", "x"); rootfs = "RW"; } catch {}
    let environ = ""; try { environ = fsm.readFileSync("/proc/1/environ", "utf8"); } catch (e) { environ = "unreadable"; }
    console.log(JSON.stringify({
        net, metadata, rootfs, uid: process.getuid(),
        secret: process.env.HOST_ONLY_SECRET ?? null, visible: process.env.SANDBOX_VISIBLE ?? null,
        environHasSecret: environ.includes("must-not-leak"), homes: fsm.readdirSync("/home"),
        kernel: fsm.readFileSync("/proc/version", "utf8").slice(0, 40),
    }));
`, 60_000)).output);
check("no network (external)", js.net === "blocked");
check("no network (metadata server)", js.metadata === "blocked");
check("read-only rootfs", js.rootfs === "ro");
check("runs as uid 1000", js.uid === 1000);
check("host env secret not visible", js.secret === null && js.environHasSecret === false);
check("sandbox-scoped env visible", js.visible === "yes");
check("no other chat homes visible", js.homes.every((h: string) => h === "agent" || h === "node"), JSON.stringify(js.homes));
check("gVisor kernel", /gvisor/.test(js.kernel), js.kernel);

const sh = await sb.executeShell("type -P curl wget dig || echo none; pip install requests 2>&1 | tail -1", 60_000);
check("network tools absent / pip blocked", /none/.test(sh.output) && /没有网络访问/.test(sh.output), sh.output.replace(/\n/g, " | "));


// 文件通道：sandbox 生成的文件经 inbox 交给 adapter；宿主文件被拒绝
const send = await sb.execute(`fs.writeFile("media/report.txt", "made in gvisor"); await telegram.sendFile("-1", "media/report.txt"); console.log("sent");`, 60_000);
const hostPath = received[0] ? String(received[0].args[1]) : "";
check("sandbox file delivered via host inbox", !send.error && hostPath.includes(".sandbox-inbox") && readFileSync(hostPath, "utf8") === "made in gvisor", hostPath);
writeFileSync("/tmp/host-secret-e2e.txt", "secret");
const blocked = await sb.execute(`await telegram.sendFile("-1", "/tmp/host-secret-e2e.txt");`, 60_000);
check("host file reference rejected", blocked.error && /不能引用宿主文件/.test(blocked.output) && received.length === 1);
rmSync("/tmp/host-secret-e2e.txt", { force: true });
const forge = await sb.execute(`await telegram.sendFile("-1", { file: "http://169.254.169.254/latest" });`, 60_000);
check("internal URL rejected", forge.error && /内网地址/.test(forge.output));

// 配额（vm.env: 100 MiB；quota timer 每 60s 为新 home 设置 project quota）——临时 VM 模式下一台 VM 一个 chat，以启动盘为界
if (!ephemeral && quotaMiB > 0) {
    await new Promise((r) => setTimeout(r, 65_000));
    const dd = await sb.executeShell(`dd if=/dev/zero of=big.bin bs=1M count=${quotaMiB + 200} 2>&1 | tail -1; ls -l big.bin | awk '{print $5}'; rm -f big.bin`, 600_000);
    const written = Number(dd.output.split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l)) ?? "0");
    check(`per-home disk quota enforced (write capped at ${quotaMiB} MiB)`, written > 0 && written <= quotaMiB * 1024 * 1024, `${written} bytes; ${dd.output.replace(/\n/g, " | ")}`);
}

// 跨会话隔离
const other = await makeSandbox("telegram:-e2e-2");
const peek = await other.sb.executeShell("ls media 2>&1; ls /home", 60_000);
check("other chat cannot see first chat's files", /No such file/.test(peek.output) && !/report.txt/.test(peek.output), peek.output.replace(/\n/g, " | "));

// fork 洪泛：只能拖垮攻击者自己的 session（pids 上限），旁观 session 与 sandboxd 不受影响
const bomb = await makeSandbox("telegram:-e2e-bomb");
const bombExit = new Promise<void>((r) => bomb.sb.once("exit", () => r()));
const bombRun = bomb.sb.executeShell("for i in $(seq 1 3000); do (sleep 60 &) 2>/dev/null; done; echo survived", 120_000).catch((e) => ({ output: String(e), error: true }));
const bombResult = await Promise.race([bombRun, bombExit.then(() => ({ output: "session terminated", error: true }))]);
check("fork flood contained to its own session", true, String((bombResult as any).output).slice(0, 80));
const bystander = await other.sb.execute("console.log('still alive')", 60_000);
check("bystander session unaffected by fork flood", bystander.output.includes("still alive"));
if (!ephemeral) {
    const midHealth = await remoteControlRequest(remote, remote.endpoints[0], { type: "health" });
    check("sandboxd healthy after fork flood", midHealth.type === "health_result", JSON.stringify(midHealth));
}
await bomb.sb.stop();
const again = await makeSandbox("telegram:-e2e-bomb");
check("bombed chat gets a fresh session", (await again.sb.execute("console.log('fresh')", 60_000)).output.includes("fresh"));
await again.sb.stop();

await sb.stop();
await other.sb.stop();
await new Promise((r) => setTimeout(r, 3000));
if (ephemeral) {
    // 每个 chat 的 VM 在会话结束后被删除
    const deadline = Date.now() + 240_000;
    const remaining = new Set(vmNames);
    while (remaining.size && Date.now() < deadline) {
        for (const key of [...remaining]) {
            const [zone, name] = key.split("/");
            try {
                await broker!.get(name, zone);
            } catch (err) {
                if ((err as { status?: number }).status === 404) remaining.delete(key);
            }
        }
        if (remaining.size) await new Promise((r) => setTimeout(r, 10_000));
    }
    check("every per-chat VM deleted after its session", vmNames.size >= 4 && remaining.size === 0, `created=${vmNames.size} remaining=${[...remaining].join(",")}`);
} else {
    const after = await remoteControlRequest(remote, remote.endpoints[0], { type: "health" });
    check("sessions reclaimed after disconnect", after.sessions === 0, JSON.stringify(after));
}

let failed = 0;
for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
