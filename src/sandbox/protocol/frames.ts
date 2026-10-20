/**
 * frames.ts — sandbox（worker / supervisor）→ host 帧的 schema 校验
 *
 * 所有字段在 host 侧按不可信数据校验：类型、长度、数值范围。
 * 超长文本字段在此截断（而非拒绝），数值控制字段在此钳制。
 */

import { z } from "zod";
import type { ProtocolLimits } from "./limits.js";
import { truncateText } from "./ndjson.js";

export type WorkerFrame =
    | { type: "result"; id: string; output: string; error: boolean; extendSteps?: number; timeoutMs?: number }
    | { type: "notify"; event: Record<string, unknown> }
    | { type: "input_request"; id: string; prompt: string }
    | { type: "print"; message: string }
    | { type: "host_call"; id: string; method: string; args: unknown[] }
    // ─── supervisor 帧 ───
    | { type: "ready" }
    | { type: "shell_result"; id: string; output: string; error: boolean }
    | { type: "op_result"; id: string; ok: boolean; value?: unknown; error?: string }
    | { type: "shell_wake"; event: ShellWakeFrameEvent }
    | { type: "shell_state"; activeBackground: number }
    | { type: "stderr"; data: string }
    | { type: "worker_exit"; code: number | null; signal: string | null; error?: string }
    | { type: "pong"; id: string }
    | { type: "protocol_violation"; reason: string };

export interface ShellWakeFrameEvent {
    tabId: string;
    reason: "exit" | "idle" | "hard";
    command: string;
    exitCode?: number;
    recentOutput: string;
}

export type ParseFrameResult = { ok: true; frame: WorkerFrame } | { ok: false; reason: string };

function buildSchemas(limits: ProtocolLimits) {
    const id = z.string().min(1).max(limits.maxIdLength);
    const plainObject = z.record(z.string(), z.unknown());

    return z.discriminatedUnion("type", [
        z.object({
            type: z.literal("result"),
            id,
            output: z.string().optional(),
            error: z.boolean().optional(),
            extendSteps: z.number().optional(),
            timeoutMs: z.number().optional(),
        }),
        z.object({
            type: z.literal("notify"),
            event: plainObject,
        }),
        z.object({
            type: z.literal("input_request"),
            id,
            prompt: z.string(),
        }),
        z.object({
            type: z.literal("print"),
            message: z.string(),
        }),
        z.object({
            type: z.literal("host_call"),
            id,
            method: z.string().min(1).max(limits.maxMethodLength).regex(/^[A-Za-z0-9_.$-]+$/),
            args: z.array(z.unknown()).optional(),
        }),
        z.object({ type: z.literal("ready") }),
        z.object({ type: z.literal("shell_result"), id, output: z.string(), error: z.boolean() }),
        z.object({ type: z.literal("op_result"), id, ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }),
        z.object({
            type: z.literal("shell_wake"),
            event: z.object({
                tabId: z.string().min(1).max(limits.maxIdLength),
                reason: z.enum(["exit", "idle", "hard"]),
                command: z.string(),
                exitCode: z.number().int().optional(),
                recentOutput: z.string(),
            }),
        }),
        z.object({ type: z.literal("shell_state"), activeBackground: z.number().int().min(0).max(1000) }),
        z.object({ type: z.literal("stderr"), data: z.string() }),
        z.object({
            type: z.literal("worker_exit"),
            code: z.number().int().nullable().optional(),
            signal: z.string().nullable().optional(),
            error: z.string().optional(),
        }),
        z.object({ type: z.literal("pong"), id }),
        z.object({ type: z.literal("protocol_violation"), reason: z.string() }),
    ]);
}

const schemaCache = new WeakMap<ProtocolLimits, ReturnType<typeof buildSchemas>>();

function getSchema(limits: ProtocolLimits) {
    let schema = schemaCache.get(limits);
    if (!schema) {
        schema = buildSchemas(limits);
        schemaCache.set(limits, schema);
    }
    return schema;
}

function clampExtendSteps(value: unknown, limits: ProtocolLimits): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
    return Math.min(value, limits.maxExtendSteps);
}

function clampTimeout(value: unknown, limits: ProtocolLimits): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
    return Math.min(Math.max(value, limits.minTimeoutMs), limits.maxTimeoutMs);
}

export function parseWorkerFrame(raw: unknown, limits: ProtocolLimits): ParseFrameResult {
    const parsed = getSchema(limits).safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, reason: issue ? `${issue.path.join(".") || "frame"}: ${issue.message}` : "invalid frame" };
    }
    const frame = parsed.data;
    switch (frame.type) {
        case "result":
            return {
                ok: true,
                frame: {
                    type: "result",
                    id: frame.id,
                    output: truncateText(frame.output ?? "", limits.maxOutputChars),
                    error: frame.error ?? false,
                    extendSteps: clampExtendSteps(frame.extendSteps, limits),
                    timeoutMs: clampTimeout(frame.timeoutMs, limits),
                },
            };
        case "notify":
            return { ok: true, frame: { type: "notify", event: frame.event } };
        case "input_request":
            return { ok: true, frame: { type: "input_request", id: frame.id, prompt: truncateText(frame.prompt, limits.maxPromptChars) } };
        case "print":
            return { ok: true, frame: { type: "print", message: truncateText(frame.message, limits.maxPrintChars) } };
        case "host_call":
            return { ok: true, frame: { type: "host_call", id: frame.id, method: frame.method, args: frame.args ?? [] } };
        case "ready":
            return { ok: true, frame: { type: "ready" } };
        case "shell_result":
            return { ok: true, frame: { type: "shell_result", id: frame.id, output: truncateText(frame.output, limits.maxOutputChars), error: frame.error } };
        case "op_result":
            return {
                ok: true,
                frame: {
                    type: "op_result",
                    id: frame.id,
                    ok: frame.ok,
                    value: frame.value,
                    ...(frame.error !== undefined ? { error: truncateText(frame.error, limits.maxPrintChars) } : {}),
                },
            };
        case "shell_wake":
            return {
                ok: true,
                frame: {
                    type: "shell_wake",
                    event: {
                        tabId: frame.event.tabId,
                        reason: frame.event.reason,
                        command: truncateText(frame.event.command, limits.maxPromptChars),
                        ...(frame.event.exitCode !== undefined ? { exitCode: frame.event.exitCode } : {}),
                        recentOutput: frame.event.recentOutput.slice(-2000),
                    },
                },
            };
        case "shell_state":
            return { ok: true, frame: { type: "shell_state", activeBackground: frame.activeBackground } };
        case "stderr":
            return { ok: true, frame: { type: "stderr", data: truncateText(frame.data, limits.maxPrintChars) } };
        case "worker_exit":
            return {
                ok: true,
                frame: {
                    type: "worker_exit",
                    code: frame.code ?? null,
                    signal: frame.signal ? frame.signal.slice(0, 32) : null,
                    ...(frame.error ? { error: truncateText(frame.error, limits.maxPrintChars) } : {}),
                },
            };
        case "pong":
            return { ok: true, frame: { type: "pong", id: frame.id } };
        case "protocol_violation":
            return { ok: true, frame: { type: "protocol_violation", reason: frame.reason.slice(0, 200) } };
    }
}
