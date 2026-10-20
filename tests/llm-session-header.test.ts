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

describe("session header", () => {
    it("sends the session id under the configured header only when both are set", async () => {
        const seen: IncomingHttpHeaders[] = [];
        const baseUrl = await startServer(seen);
        const msgs = [{ role: "user" as const, content: "hi" }];

        await callLLM(msgs, profile(baseUrl, { sessionHeader: "x-session-id", customHeaders: { "x-team": "t" } }), { sessionId: "01ABC", caller: "test" });
        await callLLM(msgs, profile(baseUrl, { sessionHeader: "x-session-id" }), { caller: "test" });
        await callLLM(msgs, profile(baseUrl), { sessionId: "01ABC", caller: "test" });

        assert.equal(seen[0]["x-session-id"], "01ABC");
        assert.equal(seen[0]["x-team"], "t");
        assert.equal(seen[1]["x-session-id"], undefined);
        assert.equal(seen[2]["x-session-id"], undefined);
    });

    it("parses and serialises session_header", () => {
        const dir = mkdtempSync(join(tmpdir(), "cgm-session-header-"));
        try {
            const path = join(dir, "c.yaml");
            writeFileSync(path, "llm_profiles:\n  default:\n    provider: openai\n    api_key: k\n    model: m\n    session_header: x-session-id\n");
            const cfg = loadConfig(path, true);
            assert.equal(cfg.llmProfiles.default.sessionHeader, "x-session-id");
            assert.equal(saveConfig(cfg, path).ok, true);
            assert.equal(parseYAML(readFileSync(path, "utf-8")).llm_profiles.default.session_header, "x-session-id");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
