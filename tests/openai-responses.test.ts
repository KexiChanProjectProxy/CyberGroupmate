import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { LLMConfig } from "../src/core/config.js";
import {
    callOpenAIResponses,
    closeOpenAIResponsesWebSockets,
    isRetryableResponsesWebSocketError,
    truncateAtStop,
} from "../src/core/llm/openai-responses.js";
import { reasoningOriginKey } from "../src/core/llm/reasoning-origin.js";
import type { ChatMessage } from "../src/core/llm/types.js";

const websocketServers: WebSocketServer[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
    closeOpenAIResponsesWebSockets();
    await Promise.all(websocketServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close(error => error ? reject(error) : resolve());
    })));
    await Promise.all(httpServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function startResponsesWebSocketServer(): Promise<{
    baseUrl: string;
    requests: Array<Record<string, any>>;
    connections: WebSocket[];
}> {
    const requests: Array<Record<string, any>> = [];
    const connections: WebSocket[] = [];
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/v1/responses" });
    websocketServers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    server.on("connection", socket => {
        connections.push(socket);
        socket.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Record<string, any>;
            requests.push(request);
            const turn = requests.length;
            const responseId = `resp_${turn}`;
            const answer = `answer ${turn}`;
            const reasoningItem = {
                id: `rs_${turn}`,
                type: "reasoning",
                summary: [],
                encrypted_content: `encrypted-${turn}`,
            };
            socket.send(JSON.stringify({ type: "response.created", response: { id: responseId } }));
            socket.send(JSON.stringify({ type: "response.output_item.done", item: reasoningItem }));
            socket.send(JSON.stringify({ type: "response.output_text.delta", delta: answer }));
            socket.send(JSON.stringify({
                type: "response.completed",
                response: {
                    id: responseId,
                    output: [{
                        id: `msg_${turn}`,
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: answer, annotations: [] }],
                    }],
                    usage: {
                        input_tokens: 3,
                        output_tokens: 5,
                        total_tokens: 8,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: turn + 10 },
                    },
                },
            }));
        });
    });
    const address = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, connections };
}

function websocketConfig(baseUrl: string): LLMConfig {
    return {
        provider: "openai_responses",
        baseUrl,
        apiKey: "test-key",
        model: "reasoning-model",
        temperature: 1,
        maxTokens: 1024,
        responsesRequestMode: "websocket",
        omit_max_output_tokens: true,
    };
}

/** Responses SSE：按序写出事件；destroyAfter 时写完后直接断开 socket（模拟网关在完成事件后 / 前断连） */
async function startSseServer(events: Array<Record<string, unknown>>, destroyAfter = false) {
    const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            if (destroyAfter) setImmediate(() => res.socket?.destroy());
            else res.end();
        });
    });
    httpServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const profile: LLMConfig = {
        ...websocketConfig(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`),
        responsesRequestMode: "stream",
    };
    return profile;
}

const created = { type: "response.created", response: { id: "resp_s", created_at: 1, model: "reasoning-model", service_tier: null } };
const messageItem = { id: "msg_s", type: "message", role: "assistant", status: "completed", content: [] as unknown[] };
const textEvents = (text: string) => [
    { type: "response.output_item.added", output_index: 1, item: { ...messageItem, status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "msg_s", output_index: 1, content_index: 0, delta: text.slice(0, 3), logprobs: [] },
    { type: "response.output_text.delta", item_id: "msg_s", output_index: 1, content_index: 0, delta: text.slice(3), logprobs: [] },
];
const completed = (usage: Record<string, unknown> | null) => ({
    type: "response.completed",
    response: { id: "resp_s", created_at: 1, model: "reasoning-model", status: "completed", incomplete_details: null, service_tier: null, output: [], usage },
});

describe("OpenAI Responses stream mode", () => {
    it("keeps reasoning output_item.done when completed output omits it", async () => {
        const reasoningItem = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" };
        const profile = await startSseServer([
            created,
            { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], encrypted_content: null } },
            { type: "response.output_item.done", output_index: 0, item: reasoningItem },
            ...textEvents("answer"),
            completed(null),
        ]);

        const result = await callOpenAIResponses([{ role: "user", content: "q" }], profile, profile.model, 1, 1024, "high");

        assert.equal(result.content, "answer");
        assert.deepEqual(result.reasoning?.provider === "openai_responses" && result.reasoning.items, [reasoningItem]);
    });

    it("accepts Premature close after response.completed", async () => {
        const profile = await startSseServer([
            created,
            ...textEvents("hello"),
            completed({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
        ], true);

        const result = await callOpenAIResponses([{ role: "user", content: "q" }], profile, profile.model, 1, 1024);

        assert.equal(result.content, "hello");
        assert.equal(result.usage?.promptTokens, 1);
        assert.equal(result.usage?.completionTokens, 2);
    });

    it("does not accept Premature close before response.completed", async () => {
        const profile = await startSseServer([created, ...textEvents("partial")], true);

        await assert.rejects(
            callOpenAIResponses([{ role: "user", content: "q" }], profile, profile.model, 1, 1024),
            /ended before completion/,
        );
    });
});

describe("OpenAI Responses stop sequences", () => {
    it("never sends stop (not a Responses parameter) and truncates client-side", async () => {
        const bodies: Array<Record<string, any>> = [];
        const server = createServer((req, res) => {
            let raw = "";
            req.on("data", chunk => { raw += chunk; });
            req.on("end", () => {
                bodies.push(JSON.parse(raw) as Record<string, any>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "resp_stop",
                    object: "response",
                    status: "completed",
                    output_text: "```js\nrun()\n```\n[MetaSandbox observation] fabricated",
                    output: [{
                        id: "msg_stop",
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "```js\nrun()\n```\n[MetaSandbox observation] fabricated", annotations: [] }],
                    }],
                }));
            });
        });
        httpServers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const profile = { ...websocketConfig(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`), responsesRequestMode: "non_stream" as const };

        const result = await callOpenAIResponses(
            [{ role: "user", content: "go" }],
            profile, profile.model, 1, 1024, undefined, undefined, ["[MetaSandbox observation]"],
        );

        assert.equal(bodies.length, 1);
        assert.equal("stop" in bodies[0], false);
        assert.equal(result.content, "```js\nrun()\n```\n");
    });

    it("truncates at the earliest of several stop sequences", () => {
        assert.equal(truncateAtStop("a STOP2 b STOP1 c", ["STOP1", "STOP2"]), "a ");
        assert.equal(truncateAtStop("no stop here", ["X"]), "no stop here");
        assert.equal(truncateAtStop("keep", undefined), "keep");
    });
});

describe("OpenAI Responses WebSocket mode", () => {
    it("only falls back to HTTP for transient WebSocket failures", () => {
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1013): upstream websocket is busy, please retry later"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1011): upstream websocket proxy failed"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Unexpected server response: 503"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1000): normal closure"),
        ), false);
    });

    it("falls back to HTTP after a 1013 close and keeps encrypted reasoning", async () => {
        const httpRequests: Array<Record<string, any>> = [];
        const reasoningItem = {
            id: "rs_http_fallback",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-http-fallback",
        };
        const httpServer = createServer((req, res) => {
            let raw = "";
            req.on("data", chunk => { raw += chunk; });
            req.on("end", () => {
                httpRequests.push(JSON.parse(raw) as Record<string, any>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "resp_http_fallback",
                    object: "response",
                    status: "completed",
                    output_text: "answer over http",
                    output: [reasoningItem, {
                        id: "msg_http_fallback",
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "answer over http", annotations: [] }],
                    }],
                    usage: {
                        input_tokens: 3,
                        output_tokens: 5,
                        total_tokens: 8,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 4 },
                    },
                }));
            });
        });
        httpServers.push(httpServer);
        const wsServer = new WebSocketServer({ server: httpServer, path: "/v1/responses" });
        websocketServers.push(wsServer);
        wsServer.on("connection", socket => socket.once("message", () => {
            socket.close(1013, "upstream websocket is busy, please retry later");
        }));
        await new Promise<void>((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(0, "127.0.0.1", resolve);
        });
        const address = httpServer.address() as AddressInfo;
        const profile = websocketConfig(`http://127.0.0.1:${address.port}/v1`);

        const result = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(result.content, "answer over http");
        assert.deepEqual(result.reasoning, {
            provider: "openai_responses",
            items: [reasoningItem],
            originKey: reasoningOriginKey(profile, profile.model),
            tokenCount: 4,
        });
        assert.equal(httpRequests.length, 1);
        assert.deepEqual(httpRequests[0].include, ["reasoning.encrypted_content"]);
    });

    it("continues incrementally on one connection and rebuilds after disconnect", async () => {
        const { baseUrl, requests, connections } = await startResponsesWebSocketServer();
        const profile = websocketConfig(baseUrl);
        const first = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(connections.length, 1);
        assert.equal(requests[0].type, "response.create");
        assert.equal(requests[0].stream, undefined);
        assert.equal(requests[0].background, undefined);
        assert.equal(requests[0].max_output_tokens, undefined);
        assert.equal(requests[0].previous_response_id, undefined);
        assert.deepEqual(requests[0].input, [
            { role: "user", content: [{ type: "input_text", text: "first" }] },
        ]);
        assert.equal(first.content, "answer 1");
        assert.equal(first.reasoning?.provider, "openai_responses");
        assert.deepEqual(first.reasoning && "items" in first.reasoning ? first.reasoning.items : [], [{
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-1",
        }]);
        assert.equal(first.reasoning && "responseId" in first.reasoning ? first.reasoning.responseId : undefined, "resp_1");
        assert.ok(first.reasoning && "websocketSessionId" in first.reasoning && first.reasoning.websocketSessionId);

        const secondMessages: ChatMessage[] = [
            { role: "user", content: "first" },
            { role: "assistant", content: first.content, reasoning: first.reasoning },
            { role: "user", content: "second" },
        ];
        const second = await callOpenAIResponses(
            secondMessages,
            profile, profile.model, 1, 1024, "high", "prefix: ",
        );

        assert.equal(connections.length, 1);
        assert.equal(requests[1].previous_response_id, "resp_1");
        assert.deepEqual(requests[1].input, [
            { role: "user", content: [{ type: "input_text", text: "second" }] },
            { role: "assistant", content: "prefix: " },
        ]);
        assert.equal(second.reasoning && "responseId" in second.reasoning ? second.reasoning.responseId : undefined, "resp_2");

        closeOpenAIResponsesWebSockets();
        const thirdMessages: ChatMessage[] = [
            ...secondMessages,
            { role: "assistant", content: second.content, reasoning: second.reasoning },
            { role: "user", content: "third" },
        ];
        await callOpenAIResponses(
            thirdMessages,
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(connections.length, 2);
        assert.equal(requests[2].previous_response_id, undefined);
        assert.equal(requests[2].input.some((item: Record<string, unknown>) => item.type === "reasoning"), false);
        assert.deepEqual(requests[2].input.map((item: Record<string, unknown>) => item.role), [
            "user", "assistant", "user", "assistant", "user",
        ]);
    });

    it("does not continue from a response id issued to another profile", async () => {
        const { baseUrl, requests } = await startResponsesWebSocketServer();
        const profile = websocketConfig(baseUrl);
        const first = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        // 更近的一轮由别的 profile 应答：它的 responseId 不在本连接的命名空间里。
        await callOpenAIResponses([
            { role: "user", content: "first" },
            { role: "assistant", content: first.content, reasoning: first.reasoning },
            { role: "user", content: "second" },
            {
                role: "assistant",
                content: "answer from elsewhere",
                reasoning: {
                    provider: "openai_responses",
                    items: [{ id: "item_from_another_gateway", type: "reasoning", summary: [] }],
                    responseId: "resp_elsewhere",
                    originKey: "another-profile",
                },
            },
            { role: "user", content: "third" },
        ], profile, profile.model, 1, 1024, "high");

        assert.equal(requests[1].previous_response_id, undefined);
        assert.equal(
            requests[1].input.some((item: Record<string, unknown>) => item.type === "reasoning"),
            false,
        );
        assert.deepEqual(requests[1].input.map((item: Record<string, unknown>) => item.role), [
            "user", "assistant", "user", "assistant", "user",
        ]);
    });

    it("returns partial output when the response is incomplete", async () => {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/v1/responses" });
        websocketServers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        server.on("connection", socket => socket.once("message", () => {
            socket.send(JSON.stringify({
                type: "response.incomplete",
                response: {
                    id: "resp_incomplete",
                    output: [{
                        id: "msg_incomplete",
                        type: "message",
                        role: "assistant",
                        status: "incomplete",
                        content: [{ type: "output_text", text: "partial answer", annotations: [] }],
                    }],
                    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
                },
            }));
        }));
        const address = server.address() as AddressInfo;
        const profile = websocketConfig(`http://127.0.0.1:${address.port}/v1`);

        const result = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(result.content, "partial answer");
        assert.equal(result.usage?.totalTokens, 5);
    });
});
