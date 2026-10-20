/**
 * remote-transport.ts — host 侧连接 sandboxd，完成握手后返回字节流
 *
 * 传输：mTLS；或在同一 GCP VPC 内网中使用纯 TCP（tls 省略）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Duplex, Readable } from "node:stream";
import * as net from "node:net";
import * as tls from "node:tls";
import { createLogger } from "../../core/logger.js";
import { safeParseJson } from "../protocol/ndjson.js";
import { HANDSHAKE_VERSION, readHandshakeLines, SKILLS_CHUNK_BYTES, writeJsonLine } from "../remote/handshake.js";

const log = createLogger("sandbox-remote");

export interface RemoteEndpoint {
    name: string;
    address: string;
    servername?: string;
}

export interface RemoteTransportConfig {
    endpoints: RemoteEndpoint[];
    /** 省略 → 纯 TCP（仅限 VPC 内网） */
    tls?: { ca: string; cert: string; key: string } | null;
    connectTimeoutMs: number;
    /** 握手（含 skills 上传）超时 */
    handshakeTimeoutMs?: number;
}

export interface RemoteSessionOpenRequest {
    chatId: string;
    env: Record<string, string>;
    shellPath: string;
    skillsHash: string | null;
}

export interface RemoteSession {
    socket: net.Socket;
    /** sandbox 内实际 home（用于识别 sandbox 路径） */
    home: string;
    sessionId: string;
    endpoint: RemoteEndpoint;
}

export class RemoteSessionError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "RemoteSessionError";
    }
}

/**
 * Rendezvous hashing：同一 chat 总落在同一端点（其 home 在那台 VM 上），
 * 增删端点时只有少量 chat 迁移。
 */
export function selectEndpoint(endpoints: RemoteEndpoint[], chatId: string): RemoteEndpoint {
    if (endpoints.length === 0) throw new Error("没有可用的 sandbox endpoint");
    let best = endpoints[0];
    let bestScore = -1n;
    for (const ep of endpoints) {
        const score = BigInt("0x" + createHash("sha256").update(`${ep.name}\n${chatId}`).digest("hex").slice(0, 15));
        if (score > bestScore) {
            best = ep;
            bestScore = score;
        }
    }
    return best;
}

function splitAddress(address: string): { host: string; port: number } {
    const idx = address.lastIndexOf(":");
    if (idx <= 0) throw new Error(`invalid sandbox endpoint address: ${address}`);
    return { host: address.slice(0, idx), port: Number(address.slice(idx + 1)) };
}

let tlsMaterialCache: { key: string; value: { ca: Buffer; cert: Buffer; key: Buffer } } | null = null;

function loadTlsMaterial(cfg: NonNullable<RemoteTransportConfig["tls"]>): { ca: Buffer; cert: Buffer; key: Buffer } {
    const cacheKey = `${cfg.ca}\n${cfg.cert}\n${cfg.key}`;
    if (tlsMaterialCache?.key === cacheKey) return tlsMaterialCache.value;
    const value = { ca: readFileSync(cfg.ca), cert: readFileSync(cfg.cert), key: readFileSync(cfg.key) };
    tlsMaterialCache = { key: cacheKey, value };
    return value;
}

/** 建立到 sandboxd 的连接（mTLS 或 VPC 内纯 TCP） */
export function connectEndpoint(cfg: Pick<RemoteTransportConfig, "tls" | "connectTimeoutMs">, endpoint: RemoteEndpoint): Promise<net.Socket> {
    const { host, port } = splitAddress(endpoint.address);
    return new Promise<net.Socket>((resolve, reject) => {
        let s: net.Socket;
        const readyEvent = cfg.tls ? "secureConnect" : "connect";
        if (cfg.tls) {
            const material = loadTlsMaterial(cfg.tls);
            s = tls.connect({
                host,
                port,
                servername: endpoint.servername ?? host,
                ca: material.ca,
                cert: material.cert,
                key: material.key,
                minVersion: "TLSv1.3",
                rejectUnauthorized: true,
            });
        } else {
            s = net.connect({ host, port });
        }
        const timer = setTimeout(() => {
            s.destroy();
            reject(new RemoteSessionError("connect_timeout", `连接 sandbox ${endpoint.name} (${endpoint.address}) 超时`));
        }, cfg.connectTimeoutMs);
        s.once(readyEvent, () => {
            clearTimeout(timer);
            resolve(s);
        });
        s.once("error", (err) => {
            clearTimeout(timer);
            reject(new RemoteSessionError("connect_failed", `连接 sandbox ${endpoint.name} 失败: ${err.message}`));
        });
    });
}

export async function openRemoteSession(
    cfg: RemoteTransportConfig,
    request: RemoteSessionOpenRequest,
    deps: { packSkills: () => Readable },
): Promise<RemoteSession> {
    const endpoint = selectEndpoint(cfg.endpoints, request.chatId);
    const socket = await connectEndpoint(cfg, endpoint);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    return new Promise<RemoteSession>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reader.dispose();
            socket.destroy();
            reject(err);
        };
        const timer = setTimeout(
            () => fail(new RemoteSessionError("handshake_timeout", "sandbox 会话握手超时")),
            cfg.handshakeTimeoutMs ?? 120_000,
        );
        socket.once("close", () => fail(new RemoteSessionError("closed", "sandbox 在握手阶段关闭了连接")));
        socket.once("error", (err) => fail(new RemoteSessionError("socket_error", err.message)));

        const reader = readHandshakeLines(
            socket as unknown as Duplex,
            (line) => {
                const msg = safeParseJson(line) as Record<string, unknown> | undefined;
                if (!msg || typeof msg.type !== "string") return fail(new RemoteSessionError("bad_frame", "sandbox 握手帧无效"));
                if (msg.type === "need_skills") {
                    void uploadSkills(socket, deps.packSkills()).catch((err) => fail(new RemoteSessionError("skills_upload", String(err))));
                    return;
                }
                if (msg.type === "session_error") {
                    return fail(new RemoteSessionError(String(msg.code ?? "error"), String(msg.message ?? "sandbox 拒绝了会话").slice(0, 500)));
                }
                if (msg.type === "session_ready") {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reader.finish();
                    socket.removeAllListeners("close");
                    socket.removeAllListeners("error");
                    const home = typeof msg.home === "string" && msg.home.startsWith("/") ? msg.home : "/home/agent";
                    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.slice(0, 64) : "";
                    log.info("sandbox 远程会话已建立", { chatId: request.chatId, endpoint: endpoint.name, sessionId });
                    resolve({ socket, home, sessionId, endpoint });
                    return;
                }
                fail(new RemoteSessionError("bad_frame", `sandbox 握手帧类型未知: ${msg.type.slice(0, 32)}`));
            },
            () => fail(new RemoteSessionError("bad_frame", "sandbox 握手帧过长")),
        );

        writeJsonLine(socket as unknown as Duplex, {
            type: "session_open",
            v: HANDSHAKE_VERSION,
            chatId: request.chatId,
            skillsHash: request.skillsHash,
            env: request.env,
            shellPath: request.shellPath,
        });
    });
}

async function uploadSkills(socket: net.Socket, tar: Readable): Promise<void> {
    const hash = createHash("sha256");
    let seq = 0;
    let carry = Buffer.alloc(0);
    const sendChunk = async (chunk: Buffer) => {
        hash.update(chunk);
        const ok = socket.write(JSON.stringify({ type: "skills_chunk", seq: seq++, base64: chunk.toString("base64") }) + "\n");
        if (!ok) await new Promise<void>((r) => socket.once("drain", () => r()));
    };
    for await (const data of tar) {
        carry = Buffer.concat([carry, data as Buffer]);
        while (carry.length >= SKILLS_CHUNK_BYTES) {
            await sendChunk(carry.subarray(0, SKILLS_CHUNK_BYTES));
            carry = carry.subarray(SKILLS_CHUNK_BYTES);
        }
    }
    if (carry.length > 0) await sendChunk(carry);
    socket.write(JSON.stringify({ type: "skills_end", sha256: hash.digest("hex") }) + "\n");
}

/** 一次性控制请求（health / logs_tail） */
export async function remoteControlRequest(
    cfg: RemoteTransportConfig,
    endpoint: RemoteEndpoint,
    request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const socket = await connectEndpoint(cfg, endpoint);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("sandbox control request timed out"));
        }, cfg.connectTimeoutMs);
        socket.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        const reader = readHandshakeLines(socket as unknown as Duplex, (line) => {
            clearTimeout(timer);
            reader.dispose();
            socket.end();
            const msg = safeParseJson(line);
            if (msg && typeof msg === "object") resolve(msg as Record<string, unknown>);
            else reject(new Error("invalid control response"));
        }, () => reject(new Error("control response too large")), 16 * 1024 * 1024);
        writeJsonLine(socket as unknown as Duplex, request);
    });
}
