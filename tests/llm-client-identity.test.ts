import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import { readFileSync } from "node:fs";
import type { LLMConfig } from "../src/core/config.js";
import { clearConfigCache, loadConfig, saveConfig } from "../src/core/config.js";
import { callLLM } from "../src/core/llm.js";
import { opencodeSessionId } from "../src/core/llm/client-identity.js";

const servers: Server[] = [];
afterEach(async () => {
    clearConfigCache();
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    })));
});

async function startServer(seen: IncomingHttpHeaders[]) {
    const server = createServer((req, res) => {
        seen.push(req.headers);
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
}

function profile(baseUrl: string, extra: Partial<LLMConfig> = {}): LLMConfig {
    return { provider: "openai", baseUrl, apiKey: "k", model: "m", temperature: 1, maxTokens: 64, ...extra };
}

describe("client identity (opencode)", () => {
    it("sends opencode's User-Agent and session headers, stable within a session, fresh per one-shot call", async () => {
        const seen: IncomingHttpHeaders[] = [];
        const baseUrl = await startServer(seen);
        const msgs = [{ role: "user" as const, content: "hi" }];
        const p = profile(baseUrl, { clientIdentity: "opencode", customHeaders: { "x-team": "t" } });

        await callLLM(msgs, p, { sessionId: "01LOCALSESSION", caller: "test" });
        await callLLM(msgs, p, { sessionId: "01LOCALSESSION", caller: "test" });
        await callLLM(msgs, p, { caller: "test" });
        await callLLM(msgs, profile(baseUrl), { sessionId: "01LOCALSESSION", caller: "test" });

        const [a, b, c, plain] = seen;
        assert.equal(a["user-agent"], "opencode/latest/2.1.1/cli");
        assert.match(String(a["x-opencode-session-id"]), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        for (const h of ["x-session-affinity", "x-session-id", "x-opencode-session"]) assert.equal(a[h], a["x-opencode-session-id"], h);
        assert.equal(a["x-opencode-project"], "global");
        assert.equal(a["x-opencode-client"], "cli");
        assert.equal(a["x-team"], "t");
        assert.equal(b["x-opencode-session-id"], a["x-opencode-session-id"]);
        assert.notEqual(c["x-opencode-session-id"], a["x-opencode-session-id"]);
        assert.equal(plain["x-opencode-session-id"], undefined);
        assert.notEqual(plain["user-agent"], "opencode/latest/2.1.1/cli");
    });

    it("generates descending ids like opencode (newer sorts first)", () => {
        const older = opencodeSessionId(1_792_500_000_000);
        const newer = opencodeSessionId(1_792_500_001_000);
        assert.ok(newer < older);
        assert.equal(older.length, 4 + 26);
    });

    it("parses and serialises client_identity", () => {
        const dir = mkdtempSync(join(tmpdir(), "cgm-client-identity-"));
        try {
            const path = join(dir, "c.yaml");
            writeFileSync(path, "llm_profiles:\n  default:\n    provider: openai\n    api_key: k\n    model: m\n    client_identity: opencode\n");
            const cfg = loadConfig(path, true);
            assert.equal(cfg.llmProfiles.default.clientIdentity, "opencode");
            assert.equal(saveConfig(cfg, path).ok, true);
            assert.equal(parseYAML(readFileSync(path, "utf-8")).llm_profiles.default.client_identity, "opencode");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
