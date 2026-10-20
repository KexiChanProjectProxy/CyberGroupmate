import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { LLMConfig } from "../src/core/config.js";
import { callAnthropic } from "../src/core/llm/anthropic.js";
import { reasoningOriginKey } from "../src/core/llm/reasoning-origin.js";

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function startServer(handler: (res: ServerResponse, body: Record<string, any>, index: number) => void, mode?: "stream") {
    let index = 0;
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => handler(res, JSON.parse(raw), index++));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
        provider: "anthropic", baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key", model: "test-model", temperature: 1, maxTokens: 1024,
        omit_temperature: true,
        ...(mode ? { chatRequestMode: mode } : {}),
    } satisfies LLMConfig;
}

function sse(type: string, data: Record<string, unknown>) {
    return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;
}

describe("Anthropic Messages stream", () => {
    it("aggregates fragmented SSE into text, thinking (with signature) and usage", async () => {
        let request: Record<string, any> = {};
        const profile = await startServer((res, body) => {
            request = body;
            res.writeHead(200, { "content-type": "text/event-stream" });
            const bytes = Buffer.from(
                sse("message_start", { message: { usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 1 } } })
                + sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })
                + sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "想" } })
                + sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "一想" } })
                + sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-abc" } })
                + sse("content_block_stop", { index: 0 })
                + "event: ping\ndata: {\"type\": \"ping\"}\n\n"
                + sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } })
                + sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "你好" } })
                + sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "！" } })
                + sse("content_block_stop", { index: 1 })
                + sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })
                + sse("message_stop", {}));
            // 切在多字节中文字符中间和 SSE 分隔符中间
            const cut = bytes.indexOf(Buffer.from("你")) + 1;
            const cut2 = bytes.indexOf(Buffer.from("\r\n\r\n")) + 2;
            res.write(bytes.subarray(0, cut2));
            res.write(bytes.subarray(cut2, cut));
            setTimeout(() => res.end(bytes.subarray(cut)), 5);
        }, "stream");

        const result = await callAnthropic([{ role: "user", content: "hi" }], profile, profile.model, 1, 1024);
        assert.equal(request.stream, true);
        assert.equal("temperature" in request, false);
        assert.equal(result.content, "你好！");
        assert.deepEqual(result.reasoning, {
            provider: "anthropic",
            blocks: [{ type: "thinking", thinking: "想一想", signature: "sig-abc" }],
            originKey: reasoningOriginKey(profile, profile.model),
            tokenCount: undefined,
        });
        assert.equal(result.usage?.promptTokens, 20);
        assert.equal(result.usage?.completionTokens, 9);
        assert.equal(result.usage?.cachedTokens, 5);
    });

    it("surfaces stream error events and premature ends", async () => {
        const failing = await startServer((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse("message_start", { message: { usage: {} } }) + sse("error", { error: { type: "overloaded_error", message: "Overloaded" } }));
        }, "stream");
        await assert.rejects(callAnthropic([{ role: "user", content: "hi" }], failing, failing.model, 1, 1024), /overloaded_error Overloaded/);

        const truncated = await startServer((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse("message_start", { message: { usage: {} } })
                + sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
                + sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "half" } }));
        }, "stream");
        await assert.rejects(callAnthropic([{ role: "user", content: "hi" }], truncated, truncated.model, 1, 1024), /ended before completion/);
    });

    it("keeps non-stream requests unchanged", async () => {
        let request: Record<string, any> = {};
        const profile = await startServer((res, body) => {
            request = body;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
        });
        const result = await callAnthropic([{ role: "user", content: "hi" }], profile, profile.model, 1, 1024);
        assert.equal(request.stream, false);
        assert.equal(result.content, "ok");
    });
});

describe("Anthropic thinking signature fallback", () => {
    it("retries once without replayed thinking blocks when their signature is rejected", async () => {
        const requests: Array<Record<string, any>> = [];
        const profile = await startServer((res, body, index) => {
            requests.push(body);
            if (index === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
                    message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: "recovered" }] }));
        });
        const thinking = { type: "thinking", thinking: "old", signature: "stale" };
        const result = await callAnthropic([
            { role: "user", content: "first (rewritten)" },
            { role: "assistant", content: "first answer", reasoning: { provider: "anthropic", blocks: [thinking], originKey: reasoningOriginKey(profile, profile.model) } },
            { role: "user", content: "second" },
        ], profile, profile.model, 1, 1024);
        assert.equal(result.content, "recovered");
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0].messages[1].content, [thinking, { type: "text", text: "first answer" }]);
        assert.equal(requests[1].messages[1].content, "first answer");
    });

    it("does not retry other 400 errors", async () => {
        let calls = 0;
        const profile = await startServer((res) => {
            calls++;
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }));
        });
        await assert.rejects(callAnthropic([
            { role: "user", content: "a" },
            { role: "assistant", content: "b", reasoning: { provider: "anthropic", blocks: [{ type: "thinking", thinking: "x", signature: "y" }], originKey: reasoningOriginKey(profile, profile.model) } },
            { role: "user", content: "c" },
        ], profile, profile.model, 1, 1024), /max_tokens too large/);
        assert.equal(calls, 1);
    });
});
