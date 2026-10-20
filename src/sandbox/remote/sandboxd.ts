/**
 * sandboxd.ts — 独立 VM 上的 sandbox 守护进程
 *
 * 只接受 host 的连接：mTLS（CA 校验 + 客户端证书指纹白名单），或在同一 GCP VPC 内使用纯 TCP
 * （访问控制由 VPC 防火墙只放行 cgm-host tag 保证）。每条连接 = 一个 session：
 * 握手（session_open / 可选的 skills 上传）后为该 chat 启动隔离的 supervisor（默认 docker + gVisor），
 * 然后在 socket ⇄ supervisor stdio 之间做纯字节转发——sandboxd 不解析 session 方向的任何数据，
 * 因此被攻陷的 session 无法借 sandboxd 的解析代码提权。
 *
 * 生命周期：socket 关闭 → 杀 session；supervisor 退出 → 关闭 socket；
 * host 超过 host_idle_kill_ms 无字节（host 每 15s ping）→ 杀 session；session 绝对寿命上限。
 *
 * 用法：SANDBOXD_CONFIG=/etc/cgm/sandboxd.yaml node node_modules/tsx/dist/cli.mjs src/sandbox/remote/sandboxd.ts
 */

import { createHash, randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import * as net from "node:net";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import { configureLogger, createLogger } from "../../core/logger.js";
import { safeParseJson, truncateText } from "../protocol/ndjson.js";
import { controlRequestSchema, readHandshakeLines, sessionOpenSchema, skillsChunkSchema, skillsEndSchema, writeJsonLine, type SessionErrorCode, type SessionOpen } from "./handshake.js";
import { loadAllowedFingerprints, loadSandboxdConfig, normalizeFingerprint, type SandboxdConfig } from "./sandboxd-config.js";
import { createLauncher, CONTAINER_HOME, type LaunchedSession, type SessionLauncher } from "./session-launcher.js";
import { SkillsStore, type SkillsUpload } from "./skills-store.js";

const log = createLogger("sandboxd");
const VERSION = 1;
const LOG_RING_SIZE = 5000;

interface ActiveSession {
    id: string;
    chatKey: string;
    skillsHash: string | null;
    launched: LaunchedSession;
    startedAt: number;
}

export class Sandboxd {
    private server: net.Server | null = null;
    private readonly sessions = new Map<string, ActiveSession>();
    private readonly store: SkillsStore;
    private readonly homesDir: string;
    private allowedFingerprints: Set<string>;
    private readonly logRing: Array<{ ts: number; line: string }> = [];
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private readonly sockets = new Set<net.Socket>();

    constructor(private readonly cfg: SandboxdConfig, private readonly launcher: SessionLauncher = createLauncher(cfg)) {
        this.homesDir = join(cfg.data_dir, "homes");
        mkdirSync(this.homesDir, { recursive: true, mode: 0o711 });
        this.store = new SkillsStore(cfg.data_dir, cfg.max_skills_bytes, cfg.keep_skill_generations);
        this.allowedFingerprints = loadAllowedFingerprints(cfg);
        if (!cfg.tls) {
            log.info("sandboxd 以纯 TCP 模式运行（仅限 VPC 内网，访问控制由防火墙保证）");
        } else if (this.allowedFingerprints.size === 0) {
            log.warn("未配置客户端证书指纹白名单：接受任何由 CA 签发的客户端证书");
        }
    }

    /** 供日志 sink 使用 */
    recordLog(line: string): void {
        this.logRing.push({ ts: Date.now(), line: truncateText(line, 4096) });
        if (this.logRing.length > LOG_RING_SIZE) this.logRing.splice(0, this.logRing.length - LOG_RING_SIZE);
    }

    reloadFingerprints(): void {
        try {
            this.allowedFingerprints = loadAllowedFingerprints(this.cfg);
            log.info("已重新加载客户端证书指纹", { count: this.allowedFingerprints.size });
        } catch (err) {
            log.error("重新加载客户端证书指纹失败", { error: String(err) });
        }
    }

    async listen(): Promise<{ address: string; port?: number }> {
        this.launcher.pruneOrphans();
        const tlsCfg = this.cfg.tls;
        if (tlsCfg) {
            const server = tls.createServer({
                ca: readFileSync(tlsCfg.ca),
                cert: readFileSync(tlsCfg.cert),
                key: readFileSync(tlsCfg.key),
                requestCert: true,
                rejectUnauthorized: true,
                minVersion: "TLSv1.3",
            }, (socket) => this.handleConnection(socket));
            server.on("tlsClientError", (err) => log.warn("TLS 客户端错误", { error: err.message }));
            this.server = server;
        } else {
            this.server = net.createServer((socket) => this.handleConnection(socket));
        }

        const listen = this.cfg.listen;
        await new Promise<void>((resolveListen, reject) => {
            this.server!.once("error", reject);
            if ("socket" in listen) {
                rmSync(listen.socket, { force: true });
                this.server!.listen(listen.socket, () => resolveListen());
            } else {
                this.server!.listen(listen.port, listen.host, () => resolveListen());
            }
        });
        this.sweepTimer = setInterval(() => this.sweepHomes(), 3_600_000);
        this.sweepTimer.unref();
        const addr = this.server.address();
        log.info("sandboxd 已启动", { listen: typeof addr === "string" ? addr : addr, launcher: this.cfg.launcher });
        return typeof addr === "string" ? { address: addr } : { address: addr?.address ?? "", port: addr?.port };
    }

    async close(): Promise<void> {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        for (const session of this.sessions.values()) session.launched.kill();
        this.sessions.clear();
        const closed = new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
        // server.close 会等待所有连接结束：主动断开，避免关闭挂起
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await closed;
    }

    get activeSessionCount(): number {
        return this.sessions.size;
    }

    private handleConnection(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        if (socket instanceof tls.TLSSocket) {
            const peer = socket.getPeerCertificate();
            const fingerprint = normalizeFingerprint(peer?.fingerprint256 ?? "");
            if (!socket.authorized || !fingerprint || (this.allowedFingerprints.size > 0 && !this.allowedFingerprints.has(fingerprint))) {
                log.warn("拒绝未授权的客户端", { authorized: socket.authorized, fingerprint: fingerprint.slice(0, 16) });
                writeJsonLine(socket as unknown as Duplex, { type: "session_error", code: "auth", message: "client not allowed" });
                socket.end();
                return;
            }
        }
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);

        let state: "await_open" | "await_skills" | "launching" | "piping" | "closed" = "await_open";
        let open: SessionOpen | null = null;
        let upload: SkillsUpload | null = null;
        let uploadChain: Promise<void> = Promise.resolve();

        const fail = (code: SessionErrorCode, message: string) => {
            if (state === "closed") return;
            state = "closed";
            reader.dispose();
            void upload?.abort();
            writeJsonLine(socket as unknown as Duplex, { type: "session_error", code, message });
            socket.end();
            setTimeout(() => socket.destroy(), 1000).unref();
        };

        const openTimer = setTimeout(() => {
            if (state === "await_open" || state === "await_skills") fail("bad_request", "handshake timeout");
        }, state === "await_open" ? 5_000 : this.cfg.handshake_timeout_ms);
        const handshakeTimer = setTimeout(() => {
            if (state !== "piping" && state !== "closed") fail("bad_request", "handshake timeout");
        }, this.cfg.handshake_timeout_ms);

        socket.once("close", () => {
            clearTimeout(openTimer);
            clearTimeout(handshakeTimer);
            if (state !== "piping") {
                state = "closed";
                reader.dispose();
                void upload?.abort();
            }
        });
        socket.on("error", (err) => log.debug("socket error", { error: err.message }));

        const reader = readHandshakeLines(socket as unknown as Duplex, (line) => {
            const msg = safeParseJson(line) as Record<string, unknown> | undefined;
            if (!msg || typeof msg.type !== "string") return fail("bad_request", "invalid frame");

            if (state === "await_open") {
                clearTimeout(openTimer);
                const control = controlRequestSchema.safeParse(msg);
                if (control.success) {
                    state = "closed";
                    reader.dispose();
                    writeJsonLine(socket as unknown as Duplex, this.handleControl(control.data));
                    socket.end();
                    return;
                }
                const parsed = sessionOpenSchema.safeParse(msg);
                if (!parsed.success) return fail("bad_request", "invalid session_open");
                open = parsed.data;
                if (this.sessions.size >= this.cfg.max_sessions) return fail("capacity", `sandboxd at capacity (${this.cfg.max_sessions})`);
                if (open.skillsHash && !this.store.has(open.skillsHash)) {
                    state = "await_skills";
                    writeJsonLine(socket as unknown as Duplex, { type: "need_skills", hash: open.skillsHash });
                    return;
                }
                state = "launching";
                void this.launchSession(socket, open, reader, (code, m) => fail(code, m), () => { state = "piping"; });
                return;
            }

            if (state === "await_skills" && open) {
                const currentOpen = open;
                if (msg.type === "skills_chunk") {
                    const chunk = skillsChunkSchema.safeParse(msg);
                    if (!chunk.success) return fail("bad_request", "invalid skills_chunk");
                    uploadChain = uploadChain.then(async () => {
                        if (!upload) upload = await this.store.beginUpload(currentOpen.skillsHash!);
                        await upload.write(chunk.data.seq, chunk.data.base64);
                    }).catch((err) => fail("skills_failed", String(err instanceof Error ? err.message : err)));
                    return;
                }
                if (msg.type === "skills_end") {
                    const end = skillsEndSchema.safeParse(msg);
                    if (!end.success) return fail("bad_request", "invalid skills_end");
                    state = "launching";
                    uploadChain = uploadChain.then(async () => {
                        if (!upload) upload = await this.store.beginUpload(currentOpen.skillsHash!);
                        await upload.finish(end.data.sha256);
                        upload = null;
                        await this.launchSession(socket, currentOpen, reader, (code, m) => fail(code, m), () => { state = "piping"; });
                    }).catch((err) => fail("skills_failed", String(err instanceof Error ? err.message : err)));
                    return;
                }
                return fail("bad_request", "unexpected frame during skills upload");
            }

            fail("bad_request", "unexpected frame");
        }, () => fail("bad_request", "frame too large"));
    }

    private handleControl(req: { type: "health" } | { type: "logs_tail"; since?: number }): Record<string, unknown> {
        if (req.type === "health") {
            let freeBytes: number | null = null;
            try {
                const st = statfsSync(this.homesDir);
                freeBytes = st.bavail * st.bsize;
            } catch { /* ignore */ }
            return {
                type: "health_result",
                version: VERSION,
                sessions: this.sessions.size,
                maxSessions: this.cfg.max_sessions,
                launcher: this.cfg.launcher,
                freeBytes,
            };
        }
        const since = req.since ?? 0;
        return { type: "logs_result", lines: this.logRing.filter((l) => l.ts > since).slice(-2000) };
    }

    private prepareHome(chatKey: string): string {
        const home = join(this.homesDir, chatKey);
        if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
        const owner = this.cfg.home_owner ?? (this.cfg.launcher === "docker" ? parseUser(this.cfg.docker.user) : null);
        if (owner) {
            try { chownSync(home, owner.uid, owner.gid); } catch (err) { log.warn("chown home 失败", { error: String(err) }); }
        }
        const marker = join(home, ".last_used");
        try {
            writeFileSync(marker, "", { flag: "a" });
            utimesSync(marker, new Date(), new Date());
            if (owner) chownSync(marker, owner.uid, owner.gid);
        } catch { /* ignore */ }
        return home;
    }

    private async launchSession(
        socket: net.Socket,
        open: SessionOpen,
        reader: { finish(): void; dispose(): void },
        fail: (code: SessionErrorCode, message: string) => void,
        markPiping: () => void,
    ): Promise<void> {
        const sessionId = randomBytes(8).toString("hex");
        const chatKey = createHash("sha256").update(open.chatId).digest("hex").slice(0, 32);
        let launched: LaunchedSession;
        try {
            const homeDir = this.prepareHome(chatKey);
            const skillsDir = open.skillsHash ? this.store.pathFor(open.skillsHash) : null;
            launched = this.launcher.launch({ sessionId, chatKey, homeDir, skillsDir });
        } catch (err) {
            fail("launch_failed", err instanceof Error ? err.message : String(err));
            return;
        }
        const child = launched.child;
        const session: ActiveSession = { id: sessionId, chatKey, skillsHash: open.skillsHash, launched, startedAt: Date.now() };
        this.sessions.set(sessionId, session);

        // supervisor 视角的路径：把 host 约定的 /home/agent 换成实际 home（进程模式下二者不同）
        const rewrite = (value: string) => (launched.home === CONTAINER_HOME ? value : value.split(CONTAINER_HOME).join(launched.home));
        const env = Object.fromEntries(Object.entries(open.env).map(([k, v]) => [k, rewrite(v)]));
        const init = {
            type: "session_init",
            chatId: open.chatId,
            env,
            shellPath: rewrite(open.shellPath),
            home: launched.home,
            stateDir: join(launched.home, ".sandbox-state"),
            skillsSource: launched.skillsSource,
        };

        let ended = false;
        let lastHostByteAt = Date.now();
        const end = (reason: string) => {
            if (ended) return;
            ended = true;
            clearInterval(idleTimer);
            clearTimeout(lifetimeTimer);
            this.sessions.delete(sessionId);
            launched.kill();
            // 先 end() 让已排队的数据（如 worker_exit 帧）发完，再兜底 destroy
            if (!socket.destroyed) {
                socket.end();
                setTimeout(() => socket.destroy(), 2000).unref();
            }
            log.info("session 结束", { sessionId, chatKey: chatKey.slice(0, 8), reason, durationMs: Date.now() - session.startedAt });
        };
        const idleTimer = setInterval(() => {
            if (Date.now() - lastHostByteAt > this.cfg.host_idle_kill_ms) end("host idle");
        }, Math.min(10_000, this.cfg.host_idle_kill_ms));
        const lifetimeTimer = setTimeout(() => end("max lifetime"), this.cfg.session_max_lifetime_ms);
        idleTimer.unref();
        lifetimeTimer.unref();

        child.once("error", (err) => end(`launcher error: ${err.message}`));
        child.once("exit", (code, signal) => end(`supervisor exited code=${code} signal=${signal}`));
        child.stdin?.on("error", () => end("supervisor stdin closed"));
        let stderrBudget = 64 * 1024;
        child.stderr?.on("data", (d: Buffer) => {
            if (stderrBudget <= 0) return;
            const text = d.toString().slice(0, stderrBudget);
            stderrBudget -= text.length;
            log.debug("supervisor stderr", { sessionId, text: text.slice(0, 2000) });
        });

        child.stdin!.write(JSON.stringify(init) + "\n");
        writeJsonLine(socket as unknown as Duplex, { type: "session_ready", home: launched.home, sessionId });
        reader.finish();
        markPiping();

        socket.on("data", (data: Buffer) => {
            lastHostByteAt = Date.now();
            if (!child.stdin || child.stdin.destroyed) return;
            if (!child.stdin.write(data)) {
                socket.pause();
                child.stdin.once("drain", () => socket.resume());
            }
        });
        socket.resume();
        child.stdout!.on("data", (data: Buffer) => {
            if (socket.destroyed) return;
            if (!socket.write(data)) {
                child.stdout!.pause();
                socket.once("drain", () => child.stdout!.resume());
            }
        });
        child.stdout!.once("end", () => end("supervisor stdout ended"));
        socket.once("close", () => end("connection closed"));
        log.info("session 已启动", { sessionId, chatKey: chatKey.slice(0, 8), skills: open.skillsHash?.slice(0, 12) ?? null });
    }

    /** 清理长期未使用的 home（不删除活跃 session 的 home） */
    sweepHomes(now = Date.now()): string[] {
        const active = new Set([...this.sessions.values()].map((s) => s.chatKey));
        const removed: string[] = [];
        const ttlMs = this.cfg.home_ttl_days * 86_400_000;
        for (const name of readdirSync(this.homesDir)) {
            if (!/^[a-f0-9]{32}$/.test(name) || active.has(name)) continue;
            const dir = join(this.homesDir, name);
            let lastUsed = 0;
            try {
                lastUsed = statSync(join(dir, ".last_used")).mtimeMs;
            } catch {
                try { lastUsed = statSync(dir).mtimeMs; } catch { continue; }
            }
            if (now - lastUsed > ttlMs) {
                rmSync(dir, { recursive: true, force: true });
                removed.push(name);
            }
        }
        this.store.gc(new Set([...this.sessions.values()].map((s) => s.skillsHash).filter((h): h is string => !!h)));
        if (removed.length > 0) log.info("已清理过期 home", { count: removed.length });
        return removed;
    }
}

function parseUser(user: string): { uid: number; gid: number } {
    const [uid, gid] = user.split(":").map(Number);
    return { uid, gid };
}

// ─── CLI 入口 ───

async function main(): Promise<void> {
    const configPath = process.env.SANDBOXD_CONFIG ?? process.argv[2];
    if (!configPath) {
        console.error("用法: SANDBOXD_CONFIG=/etc/cgm/sandboxd.yaml sandboxd");
        process.exit(2);
    }
    const cfg = loadSandboxdConfig(configPath);
    let daemon: Sandboxd | null = null;
    configureLogger({
        format: "json",
        color: false,
        sink: (line) => {
            process.stdout.write(line + "\n");
            daemon?.recordLog(line);
        },
    });
    daemon = new Sandboxd(cfg);
    await daemon.listen();
    process.on("SIGHUP", () => daemon?.reloadFingerprints());
    const shutdown = () => {
        void daemon?.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
