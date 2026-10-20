/**
 * ndjson.ts — 面向不可信对端的 NDJSON 读取与解析
 *
 * - createLineReader: 带单行字节上限的行切分器（readline 无上限，恶意对端可写入无换行的超大数据撑爆内存）
 * - safeParseJson: 丢弃 __proto__ / constructor / prototype 键，防止原型污染
 * - truncateText: 统一的截断工具
 */

import type { Readable } from "node:stream";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type LineViolation = "line_too_long";

export interface LineReaderOptions {
    maxLineBytes: number;
    onLine: (line: string) => void;
    onViolation: (reason: LineViolation) => void;
}

export interface LineReader {
    dispose(): void;
}

/**
 * 从 Readable 中按 "\n" 切行。任意一行（含尚未结束的缓冲）超过 maxLineBytes 时
 * 调用 onViolation 并停止读取，后续数据全部丢弃。
 */
export function createLineReader(input: Readable, opts: LineReaderOptions): LineReader {
    let chunks: Buffer[] = [];
    let buffered = 0;
    let stopped = false;

    const stop = (reason: LineViolation) => {
        if (stopped) return;
        stopped = true;
        chunks = [];
        buffered = 0;
        input.off("data", onData);
        opts.onViolation(reason);
    };

    const emitLine = (buf: Buffer) => {
        let line = buf.toString("utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        opts.onLine(line);
    };

    const onData = (data: Buffer | string) => {
        if (stopped) return;
        let chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        while (chunk.length > 0) {
            const nl = chunk.indexOf(0x0a);
            if (nl === -1) {
                if (buffered + chunk.length > opts.maxLineBytes) {
                    stop("line_too_long");
                    return;
                }
                chunks.push(chunk);
                buffered += chunk.length;
                return;
            }
            if (buffered + nl > opts.maxLineBytes) {
                stop("line_too_long");
                return;
            }
            const head = chunk.subarray(0, nl);
            const line = chunks.length > 0 ? Buffer.concat([...chunks, head]) : head;
            chunks = [];
            buffered = 0;
            emitLine(line);
            if (stopped) return;
            chunk = chunk.subarray(nl + 1);
        }
    };

    input.on("data", onData);
    // 握手阶段可能显式 pause() 过（并 unshift 了剩余字节）；显式暂停的流不会因挂 data 监听而恢复
    input.resume();

    return {
        dispose() {
            stopped = true;
            chunks = [];
            buffered = 0;
            input.off("data", onData);
        },
    };
}

/**
 * JSON.parse，丢弃会导致原型污染的键。解析失败返回 undefined。
 */
export function safeParseJson(text: string): unknown {
    try {
        return JSON.parse(text, (key, value) => (FORBIDDEN_KEYS.has(key) ? undefined : value));
    } catch {
        return undefined;
    }
}

export function truncateText(value: string, maxChars: number, marker = "\n[…truncated by host]"): string {
    if (value.length <= maxChars) return value;
    return value.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** JSON 序列化后的 UTF-8 字节数；不可序列化返回 Infinity */
export function jsonByteLength(value: unknown): number {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
