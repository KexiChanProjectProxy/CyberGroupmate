import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { parseWorkerFrame } from "../src/sandbox/protocol/frames.js";
import { resolveLimits } from "../src/sandbox/protocol/limits.js";
import { createLineReader, jsonByteLength, safeParseJson, truncateText } from "../src/sandbox/protocol/ndjson.js";

const limits = resolveLimits();

describe("safeParseJson", () => {
    it("drops prototype-polluting keys at any depth", () => {
        const parsed = safeParseJson('{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"x":1}},"ok":2}}') as Record<string, any>;
        assert.equal(parsed.a, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), false);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed.nested, "constructor"), false);
        assert.equal(parsed.nested.ok, 2);
    });

    it("returns undefined for invalid JSON", () => {
        assert.equal(safeParseJson("{not json"), undefined);
    });
});

describe("parseWorkerFrame", () => {
    it("accepts a valid result and clamps execution-control fields", () => {
        const parsed = parseWorkerFrame({ type: "result", id: "req_1", output: "ok", error: false, extendSteps: 1e9, timeoutMs: 1e12 }, limits);
        assert.equal(parsed.ok, true);
        if (!parsed.ok || parsed.frame.type !== "result") return;
        assert.equal(parsed.frame.extendSteps, limits.maxExtendSteps);
        assert.equal(parsed.frame.timeoutMs, limits.maxTimeoutMs);
    });

    it("ignores non-integer / non-positive execution-control values", () => {
        const parsed = parseWorkerFrame({ type: "result", id: "r", extendSteps: -5, timeoutMs: 1.5 }, limits);
        assert.equal(parsed.ok, true);
        if (!parsed.ok || parsed.frame.type !== "result") return;
        assert.equal(parsed.frame.extendSteps, undefined);
        assert.equal(parsed.frame.timeoutMs, undefined);
        assert.equal(parsed.frame.output, "");
        assert.equal(parsed.frame.error, false);
    });

    it("raises a too-small timeout to the minimum", () => {
        const parsed = parseWorkerFrame({ type: "result", id: "r", timeoutMs: 10 }, limits);
        assert.ok(parsed.ok && parsed.frame.type === "result" && parsed.frame.timeoutMs === limits.minTimeoutMs);
    });

    it("truncates oversized text fields instead of passing them through", () => {
        const big = "x".repeat(limits.maxPrintChars * 2);
        const parsed = parseWorkerFrame({ type: "print", message: big }, limits);
        assert.ok(parsed.ok && parsed.frame.type === "print");
        if (!parsed.ok || parsed.frame.type !== "print") return;
        assert.ok(parsed.frame.message.length <= limits.maxPrintChars);
        assert.match(parsed.frame.message, /truncated by host/);
    });

    it("rejects unknown types, wrong shapes and bad method names", () => {
        const bad: unknown[] = [
            undefined,
            null,
            "string",
            { type: "spawn_host_process", cmd: "sh" },
            { type: "result" },
            { type: "notify", event: [1, 2] },
            { type: "notify", event: "x" },
            { type: "host_call", id: "h1", method: "a b" },
            { type: "host_call", id: "h1", method: "x".repeat(limits.maxMethodLength + 1) },
            { type: "host_call", id: "x".repeat(limits.maxIdLength + 1), method: "mcp.list" },
            { type: "input_request", id: "i1" },
        ];
        for (const frame of bad) {
            assert.equal(parseWorkerFrame(frame, limits).ok, false, JSON.stringify(frame));
        }
    });

    it("defaults host_call args to an empty array", () => {
        const parsed = parseWorkerFrame({ type: "host_call", id: "h1", method: "mcp.list" }, limits);
        assert.ok(parsed.ok && parsed.frame.type === "host_call");
        if (parsed.ok && parsed.frame.type === "host_call") assert.deepEqual(parsed.frame.args, []);
    });
});

describe("createLineReader", () => {
    it("splits lines across chunk boundaries and strips CR", () => {
        const input = new PassThrough();
        const lines: string[] = [];
        createLineReader(input, { maxLineBytes: 1024, onLine: (l) => lines.push(l), onViolation: () => assert.fail("no violation") });
        input.write("ab");
        input.write("c\r\nde");
        input.write("f\n\n中文");
        input.write("\n");
        assert.deepEqual(lines, ["abc", "def", "", "中文"]);
    });

    it("reports a violation and stops when a line exceeds the limit without a newline", () => {
        const input = new PassThrough();
        const lines: string[] = [];
        const violations: string[] = [];
        createLineReader(input, { maxLineBytes: 16, onLine: (l) => lines.push(l), onViolation: (r) => violations.push(r) });
        input.write("ok\n");
        input.write("x".repeat(10));
        input.write("x".repeat(10));
        input.write("\nafter\n");
        assert.deepEqual(lines, ["ok"]);
        assert.deepEqual(violations, ["line_too_long"]);
    });

    it("reports a violation for an oversized line that contains its newline in one chunk", () => {
        const input = new PassThrough();
        const violations: string[] = [];
        createLineReader(input, { maxLineBytes: 8, onLine: () => undefined, onViolation: (r) => violations.push(r) });
        input.write("x".repeat(20) + "\n");
        assert.deepEqual(violations, ["line_too_long"]);
    });

    it("stops emitting after dispose", () => {
        const input = new PassThrough();
        const lines: string[] = [];
        const reader = createLineReader(input, { maxLineBytes: 64, onLine: (l) => lines.push(l), onViolation: () => undefined });
        input.write("a\n");
        reader.dispose();
        input.write("b\n");
        assert.deepEqual(lines, ["a"]);
    });
});

describe("ndjson helpers", () => {
    it("truncateText keeps short text and caps long text", () => {
        assert.equal(truncateText("abc", 10), "abc");
        assert.ok(truncateText("x".repeat(100), 40).length <= 40);
    });

    it("jsonByteLength measures UTF-8 bytes and handles cycles", () => {
        assert.equal(jsonByteLength("中"), Buffer.byteLength('"中"'));
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        assert.equal(jsonByteLength(cyclic), Number.POSITIVE_INFINITY);
    });
});
