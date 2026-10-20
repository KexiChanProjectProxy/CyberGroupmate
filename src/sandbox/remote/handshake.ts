/**
 * handshake.ts — host ⇄ sandboxd 会话握手协议
 *
 * 每个 session 一条 mTLS 连接；连接生命周期 = session 生命周期。
 *
 *   host → sandboxd  session_open{v,chatId,skillsHash,env,shellPath}
 *   sandboxd → host  need_skills{hash}          （可选）
 *   host → sandboxd  skills_chunk{seq,base64}… skills_end{sha256}
 *   sandboxd → host  session_ready{home,sessionId} | session_error{code,message}
 *   ……之后 sandboxd 只做字节转发（host ⇄ 容器内 supervisor）
 *
 * 也支持一次性控制请求（无 session）：health{} → health_result、logs_tail{since} → logs_result。
 */

import { z } from "zod";
import type { Duplex } from "node:stream";

export const HANDSHAKE_VERSION = 1;
/** 握手阶段单行上限（skills_chunk 为 1 MiB 原始数据的 base64） */
export const HANDSHAKE_MAX_LINE_BYTES = 2 * 1024 * 1024;
export const SKILLS_CHUNK_BYTES = 1024 * 1024;

const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(64 * 1024));

export const sessionOpenSchema = z.object({
    type: z.literal("session_open"),
    v: z.literal(HANDSHAKE_VERSION),
    chatId: z.string().min(1).max(256),
    skillsHash: z.string().regex(/^[a-f0-9]{16,64}$/).nullable(),
    env: envSchema,
    shellPath: z.string().max(16 * 1024),
});
export type SessionOpen = z.infer<typeof sessionOpenSchema>;

export const skillsChunkSchema = z.object({
    type: z.literal("skills_chunk"),
    seq: z.number().int().min(0),
    base64: z.string().max(HANDSHAKE_MAX_LINE_BYTES),
});

export const skillsEndSchema = z.object({
    type: z.literal("skills_end"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const controlRequestSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("health") }),
    z.object({ type: z.literal("logs_tail"), since: z.number().int().min(0).optional() }),
]);

export type SessionErrorCode = "capacity" | "auth" | "bad_request" | "launch_failed" | "skills_failed" | "internal";

/**
 * 在握手阶段按行读取 socket；finish() 停止读取并把已读未处理的字节退回流中，
 * 使后续的 NDJSON 读取器从握手之后的第一个字节开始。
 */
export function readHandshakeLines(
    socket: Duplex,
    onLine: (line: string) => void,
    onViolation: () => void,
    maxLineBytes = HANDSHAKE_MAX_LINE_BYTES,
): { finish(): void; dispose(): void } {
    let pending = Buffer.alloc(0);
    let finished = false;

    const onData = (chunk: Buffer | string) => {
        if (finished) return;
        pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        while (!finished) {
            const nl = pending.indexOf(0x0a);
            if (nl === -1) {
                if (pending.length > maxLineBytes) {
                    finished = true;
                    socket.off("data", onData);
                    onViolation();
                }
                return;
            }
            if (nl > maxLineBytes) {
                finished = true;
                socket.off("data", onData);
                onViolation();
                return;
            }
            const line = pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
            pending = pending.subarray(nl + 1);
            onLine(line);
        }
    };

    socket.on("data", onData);

    return {
        finish() {
            if (finished) return;
            finished = true;
            socket.off("data", onData);
            socket.pause();
            if (pending.length > 0) socket.unshift(pending);
            pending = Buffer.alloc(0);
        },
        dispose() {
            finished = true;
            socket.off("data", onData);
            pending = Buffer.alloc(0);
        },
    };
}

export function writeJsonLine(socket: Duplex, frame: Record<string, unknown>): void {
    if (socket.destroyed || socket.writableEnded) return;
    try {
        socket.write(JSON.stringify(frame) + "\n");
    } catch { /* ignore */ }
}
