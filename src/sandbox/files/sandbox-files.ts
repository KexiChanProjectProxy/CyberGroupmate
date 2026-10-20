/**
 * sandbox-files.ts — remote sandbox 与 host 之间的文件通道
 *
 * remote 模式下 sandbox 与 host 不共享文件系统：
 * - 出站（sandbox → 平台）：host_call 参数中引用 sandbox 文件的路径，在交给 adapter 之前
 *   由 host 分块拉取到 inbox（workspace/.sandbox-inbox/<chatKey>/），再替换为 inbox 路径；
 *   引用宿主文件的路径一律拒绝（否则 sendFile("memory.db") 等于把宿主数据发到群里）。
 * - 入站（平台 → sandbox）：host 下载的媒体按 workspace 相对路径推送到 sandbox home。
 *
 * 来自 sandbox 的文件一律不可信：host 决定文件名，大小有上限。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { createLogger } from "../../core/logger.js";

const log = createLogger("sandbox-files");

const CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_PULL_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PUSH_MAX_BYTES = 50 * 1024 * 1024;
const INBOX_TTL_MS = 60 * 60_000;
const MAX_SCANNED_STRINGS = 2000;
const MAX_SCAN_DEPTH = 6;

/** Sandbox 上与文件传输相关的最小接口（便于测试） */
export interface SandboxFileTransport {
    getChatId(): string;
    getSandboxHome(): string;
    statFile(path: string): Promise<{ size: number; isFile: boolean; path: string } | null>;
    readFileChunk(path: string, offset: number, length: number): Promise<{ data: Buffer; eof: boolean; size: number }>;
    writeFileChunk(path: string, data: Buffer, append: boolean): Promise<void>;
}

export class SandboxFileError extends Error {
    constructor(readonly code: "too_large" | "not_file" | "host_path" | "blocked_url", message: string) {
        super(message);
        this.name = "SandboxFileError";
    }
}

function chatKeyOf(chatId: string): string {
    return createHash("sha256").update(chatId).digest("hex").slice(0, 32);
}

function sanitizeBasename(name: string): string {
    const base = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
    return (base || "file").slice(-80);
}

/** host 侧 inbox：存放从 sandbox 拉取的文件（位于 workspace 内，以便受 workspace 约束的 adapter 也能读取） */
export class InboxStore {
    constructor(readonly root: string = join(process.cwd(), "workspace", ".sandbox-inbox"), private readonly ttlMs = INBOX_TTL_MS) {}

    allocate(chatId: string, name: string): string {
        const dir = join(this.root, chatKeyOf(chatId));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return join(dir, `${randomUUID()}-${sanitizeBasename(name)}`);
    }

    contains(p: string): boolean {
        const rel = relative(resolve(this.root), resolve(p));
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    }

    sweep(now = Date.now()): void {
        if (!existsSync(this.root)) return;
        for (const chatDir of readdirSync(this.root)) {
            const dir = join(this.root, chatDir);
            for (const file of safeReaddir(dir)) {
                const full = join(dir, file);
                try {
                    if (now - statSync(full).mtimeMs > this.ttlMs) rmSync(full, { force: true });
                } catch { /* ignore */ }
            }
        }
    }
}

function safeReaddir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** 把 sandbox 内文件拉取到 host inbox，返回 host 路径 */
export async function pullFromSandbox(
    sandbox: SandboxFileTransport,
    sandboxPath: string,
    inbox: InboxStore,
    maxBytes = DEFAULT_PULL_MAX_BYTES,
): Promise<string> {
    const st = await sandbox.statFile(sandboxPath);
    if (!st || !st.isFile) throw new SandboxFileError("not_file", `sandbox 中不存在文件: ${sandboxPath}`);
    if (st.size > maxBytes) throw new SandboxFileError("too_large", `文件过大（${st.size} 字节，上限 ${maxBytes}）: ${sandboxPath}`);
    const target = inbox.allocate(sandbox.getChatId(), sandboxPath);
    const handle = await open(target, "wx", 0o600);
    let total = 0;
    try {
        let offset = 0;
        for (;;) {
            const chunk = await sandbox.readFileChunk(sandboxPath, offset, CHUNK_BYTES);
            total += chunk.data.length;
            if (total > maxBytes) throw new SandboxFileError("too_large", `文件过大（上限 ${maxBytes}）: ${sandboxPath}`);
            await handle.write(chunk.data);
            offset += chunk.data.length;
            if (chunk.eof || chunk.data.length === 0) break;
        }
    } catch (err) {
        await handle.close();
        rmSync(target, { force: true });
        throw err;
    }
    await handle.close();
    return target;
}

/** 把 host 文件推送到 sandbox home 下的相对路径 */
export async function pushToSandbox(
    sandbox: SandboxFileTransport,
    hostPath: string,
    sandboxRelPath: string,
    maxBytes = DEFAULT_PUSH_MAX_BYTES,
): Promise<string> {
    const st = await stat(hostPath);
    if (!st.isFile()) throw new SandboxFileError("not_file", `不是文件: ${hostPath}`);
    if (st.size > maxBytes) throw new SandboxFileError("too_large", `文件过大: ${hostPath}`);
    const handle = await open(hostPath, "r");
    try {
        let offset = 0;
        let first = true;
        const buffer = Buffer.alloc(CHUNK_BYTES);
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset);
            if (bytesRead === 0 && !first) break;
            await sandbox.writeFileChunk(sandboxRelPath, buffer.subarray(0, bytesRead), !first);
            first = false;
            offset += bytesRead;
            if (bytesRead < CHUNK_BYTES) break;
        }
    } finally {
        await handle.close();
    }
    return join(sandbox.getSandboxHome(), sandboxRelPath);
}

/** 把内存数据写入 sandbox home 下的相对路径 */
export async function pushBufferToSandbox(sandbox: SandboxFileTransport, data: Buffer, sandboxRelPath: string): Promise<string> {
    if (data.length === 0) {
        await sandbox.writeFileChunk(sandboxRelPath, data, false);
    }
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        await sandbox.writeFileChunk(sandboxRelPath, data.subarray(offset, offset + CHUNK_BYTES), offset > 0);
    }
    return join(sandbox.getSandboxHome(), sandboxRelPath);
}

// ─── 出站参数守卫 ───

const PRIVATE_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.goog"]);

function isPrivateAddress(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (PRIVATE_HOSTNAMES.has(h) || h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".localhost")) return true;
    const family = isIP(h);
    if (family === 4) {
        const [a, b] = h.split(".").map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (family === 6) {
        return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
    }
    return false;
}

/** 看起来像本地文件路径的字符串（含空白 / 换行的视为普通文本） */
function looksLikeLocalPath(value: string): boolean {
    if (value.length === 0 || value.length > 1024 || /\s/.test(value)) return false;
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value) && !value.startsWith("file://")) return false;
    return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("file://")
        || value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function hostPathCandidates(value: string): string[] {
    const raw = value.startsWith("file://") ? value.slice("file://".length) : value;
    return isAbsolute(raw)
        ? [resolve(raw)]
        : [resolve(process.cwd(), raw), resolve(process.cwd(), "workspace", raw)];
}

function hostPathExists(value: string): boolean {
    return hostPathCandidates(value).some((p) => {
        try {
            statSync(p);
            return true;
        } catch {
            return false;
        }
    });
}

function isUnderHome(p: string, home: string): boolean {
    const rel = relative(home, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * remote 模式：改写 host_call 参数中的文件引用。
 * - 指向 sandbox home 的路径（绝对、file:// 或相对）→ 拉取到 inbox，替换为 host inbox 路径；
 * - 指向宿主文件的路径 → 拒绝；
 * - 指向内网 / 元数据地址的 http(s) URL → 拒绝（host 会代为下载）。
 */
export async function rewriteRemoteFileArgs(
    args: unknown[],
    sandbox: SandboxFileTransport,
    inbox: InboxStore,
    opts: { maxBytes?: number } = {},
): Promise<unknown[]> {
    const home = sandbox.getSandboxHome();
    let scanned = 0;
    const cache = new Map<string, string>();

    const rewriteString = async (value: string): Promise<string> => {
        if (++scanned > MAX_SCANNED_STRINGS) return value;
        if (/^https?:\/\//i.test(value)) {
            try {
                if (isPrivateAddress(new URL(value).hostname)) {
                    throw new SandboxFileError("blocked_url", `[Sandbox 安全限制] 不允许让宿主访问内网地址: ${value.slice(0, 120)}`);
                }
            } catch (err) {
                if (err instanceof SandboxFileError) throw err;
            }
            return value;
        }
        if (!looksLikeLocalPath(value)) return value;
        const raw = value.startsWith("file://") ? value.slice("file://".length) : value;
        const sandboxPath = isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
        if (cache.has(sandboxPath)) return cache.get(sandboxPath)!;
        if (isUnderHome(sandboxPath, home)) {
            const st = await sandbox.statFile(sandboxPath);
            if (st?.isFile) {
                const hostPath = await pullFromSandbox(sandbox, sandboxPath, inbox, opts.maxBytes);
                log.debug("已从 sandbox 拉取文件", { chatId: sandbox.getChatId(), sandboxPath, hostPath });
                cache.set(sandboxPath, hostPath);
                return hostPath;
            }
        }
        if (hostPathExists(value)) {
            throw new SandboxFileError("host_path", `[Sandbox 安全限制] 文件不在 sandbox 中，不能引用宿主文件: ${value.slice(0, 120)}`);
        }
        return value;
    };

    const walk = async (value: unknown, depth: number): Promise<unknown> => {
        if (typeof value === "string") return rewriteString(value);
        if (depth >= MAX_SCAN_DEPTH || value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) {
            const out: unknown[] = [];
            for (const item of value) out.push(await walk(item, depth + 1));
            return out;
        }
        if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await walk(v, depth + 1);
        return out;
    };

    const result: unknown[] = [];
    for (const arg of args) result.push(await walk(arg, 0));
    return result;
}

/** host 下载目录中的文件 → sandbox home 相对路径（Downloads/<category>/<name>）；不在 workspace 下返回 null */
export function toWorkspaceRelative(hostPath: string, workspaceDir = join(process.cwd(), "workspace")): string | null {
    const rel = relative(resolve(workspaceDir), resolve(hostPath));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
}
