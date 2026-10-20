import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { parse as parseYAML } from "yaml";
import { clearConfigCache, loadConfig, saveConfig, validateConfig } from "../src/core/config.js";
import { selectEndpoint } from "../src/sandbox/transport/remote-transport.js";
import { buildSandboxRuntime } from "../src/sandbox/runtime-config.js";
import { DockerLauncher } from "../src/sandbox/remote/session-launcher.js";
import { parseSandboxdConfig } from "../src/sandbox/remote/sandboxd-config.js";

const dir = mkdtempSync(join(tmpdir(), "cgm-config-sandbox-"));
const LLM = "llm_profiles:\n  default:\n    provider: openai\n    api_key: k\n    model: m\n";

after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => clearConfigCache());

function load(yaml: string) {
    const path = join(dir, `c-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(path, LLM + yaml);
    return { path, cfg: loadConfig(path, true) };
}

describe("sandbox config", () => {
    it("defaults to local mode without host env inheritance", () => {
        const { cfg } = load("");
        assert.equal(cfg.sandbox.mode, "local");
        assert.equal(cfg.sandbox.inheritHostEnv, false);
        assert.equal(cfg.sandbox.skillsSyncBack, false);
        assert.equal(validateConfig(cfg).valid, true);
    });

    it("parses, validates and round-trips remote mode", () => {
        for (const f of ["ca.crt", "client.crt", "client.key"]) writeFileSync(join(dir, f), "x");
        const { cfg } = load([
            "sandbox:",
            "  mode: remote",
            "  ready_timeout_ms: 45000",
            "  limits:",
            "    max_concurrent_host_calls: 4",
            "  remote:",
            "    endpoints:",
            "      - name: sbx-1",
            "        address: 10.10.0.3:7443",
            "        servername: cgm-sandbox-1",
            "        max_sessions: 16",
            "    tls:",
            `      ca: ${join(dir, "ca.crt")}`,
            `      cert: ${join(dir, "client.crt")}`,
            `      key: ${join(dir, "client.key")}`,
            "",
        ].join("\n"));
        assert.equal(cfg.sandbox.mode, "remote");
        assert.equal(cfg.sandbox.readyTimeoutMs, 45000);
        assert.deepEqual(cfg.sandbox.limits, { maxConcurrentHostCalls: 4 });
        assert.equal(cfg.sandbox.remote?.endpoints[0].servername, "cgm-sandbox-1");
        assert.equal(cfg.sandbox.remote?.connectTimeoutMs, 10_000);
        assert.equal(validateConfig(cfg).valid, true, validateConfig(cfg).errors.join("; "));

        const out = join(dir, "saved.yaml");
        assert.ok(saveConfig(cfg, out).ok);
        const raw = parseYAML(readFileSync(out, "utf-8")) as Record<string, any>;
        assert.equal(raw.sandbox.mode, "remote");
        assert.equal(raw.sandbox.limits.max_concurrent_host_calls, 4);
        clearConfigCache();
        const reloaded = loadConfig(out, true);
        assert.deepEqual(reloaded.sandbox, cfg.sandbox);
    });

    it("rejects remote mode without endpoints or TLS files", () => {
        const { cfg } = load("sandbox:\n  mode: remote\n  remote:\n    endpoints: []\n    tls:\n      ca: /nonexistent/ca\n");
        const result = validateConfig(cfg);
        assert.equal(result.valid, false);
        assert.match(result.errors.join("\n"), /endpoints/);
        assert.match(result.errors.join("\n"), /tls\.cert/);
        assert.match(result.errors.join("\n"), /文件不存在/);
    });

    it("never inherits host env in remote mode", () => {
        const runtime = buildSandboxRuntime({
            mode: "remote",
            inheritHostEnv: true,
            skillsSyncBack: false,
            remote: { endpoints: [{ name: "a", address: "127.0.0.1:1" }], tls: { ca: "a", cert: "b", key: "c" }, connectTimeoutMs: 1, pingIntervalMs: 1 },
        }, dir);
        assert.equal(runtime.inheritHostEnv, false);
        assert.equal(typeof runtime.remote?.openSession, "function");
        assert.throws(() => buildSandboxRuntime({ mode: "remote", inheritHostEnv: false, skillsSyncBack: false }, dir), /endpoints/);
    });
});

describe("endpoint selection", () => {
    it("is sticky per chat and spreads chats across endpoints", () => {
        const eps = [{ name: "a", address: "1:1" }, { name: "b", address: "2:2" }, { name: "c", address: "3:3" }];
        const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
        for (let i = 0; i < 300; i++) {
            const chat = `telegram:-${i}`;
            const ep = selectEndpoint(eps, chat);
            assert.equal(selectEndpoint(eps, chat).name, ep.name);
            counts[ep.name]++;
        }
        for (const n of Object.values(counts)) assert.ok(n > 50, JSON.stringify(counts));
        // 移除一个端点时，未落在它上面的 chat 不迁移
        const remaining = eps.filter((e) => e.name !== "c");
        for (let i = 0; i < 300; i++) {
            const chat = `telegram:-${i}`;
            const before = selectEndpoint(eps, chat).name;
            if (before !== "c") assert.equal(selectEndpoint(remaining, chat).name, before);
        }
    });
});

describe("DockerLauncher", () => {
    it("builds an isolated, network-less container command", () => {
        const cfg = parseSandboxdConfig({ listen: { port: 7443 }, tls: { ca: "a", cert: "b", key: "c" }, data_dir: "/var/lib/cgm" });
        const args = new DockerLauncher(cfg.docker).buildArgs({ sessionId: "abc", chatKey: "k", homeDir: "/var/lib/cgm/homes/k", skillsDir: "/var/lib/cgm/skills/h" });
        const joined = args.join(" ");
        for (const expected of [
            "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges",
            "--runtime runsc", "--pids-limit 512", "--memory 2g", "--memory-swap 2g", "--user 1000:1000",
            "type=bind,src=/var/lib/cgm/homes/k,dst=/home/agent",
            "type=bind,src=/var/lib/cgm/skills/h,dst=/opt/skills,readonly",
        ]) {
            assert.ok(joined.includes(expected), expected);
        }
        assert.ok(!joined.includes("--privileged"));
        assert.ok(!joined.includes("docker.sock"));
        assert.equal(args[args.length - 1], cfg.docker.image);
    });
});
