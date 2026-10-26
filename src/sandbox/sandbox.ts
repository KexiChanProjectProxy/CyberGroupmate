/**
 * sandbox.ts — Sandbox Host 侧客户端
 *
 * 通过一条 NDJSON 双向流与 sandbox 侧的 SupervisorCore 通信，提供代码执行、
 * 交互式输入、PTY shell、文件传输与崩溃检测能力。
 *
 * - local 模式：SupervisorCore 在本进程内运行（worker 子进程 + 本机 PTY，与旧行为一致）；
 * - remote 模式：通过 mTLS 连接独立 VM 上的 sandboxd，每个 session 一个隔离容器。
 *
 * 威胁模型：sandbox 侧（worker 与 supervisor）视为完全受攻击者控制。
 * 所有入站帧在此按 schema 校验、截断、限速；host_call 的授权在 host-call-handler 中按绑定 chatId 执行。
 *
 * 协议见 supervisor/supervisor-core.ts 与 protocol/frames.ts。
 */

import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PassThrough, type Duplex, type Readable, type Writable } from "node:stream";
import { createLogger } from "../core/logger.js";
import { getAgentSkillScriptDirsIn } from "./skill-loader.js";
import { PROTOCOL_LIMITS, resolveLimits, type ProtocolLimits } from "./protocol/limits.js";
import { createLineReader, jsonByteLength, safeParseJson, truncateText, type LineReader } from "./protocol/ndjson.js";
import { parseWorkerFrame, type WorkerFrame } from "./protocol/frames.js";
import { guardSandboxNotify, SendLedger } from "./notify-guard.js";
import { buildEnhancedShellPath as buildShellPath, type ShellTabInfo, type ShellWakeEvent, type ShellWakeReason } from "./pty-manager.js";
import { SupervisorCore } from "./supervisor/supervisor-core.js";
import { normalizeProgrammaticTimestamps } from "../core/timezone.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger("sandbox");

export type { ShellWakeEvent, ShellWakeReason };

/** remote 模式下容器内固定的 agent home */
export const REMOTE_SANDBOX_HOME = "/home/agent";
const REMOTE_SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";

/** 兼容旧调用：基于 projectRoot/workspace 构造增强 PATH */
export function buildEnhancedShellPath(projectRoot: string, existingPath: string): string {
    const home = join(projectRoot, "workspace");
    const skillsDir = join(home, "skills");
    return buildShellPath(home, skillsDir, getAgentSkillScriptDirsIn(skillsDir), existingPath);
}

/** 执行结果 */
export interface ExecutionResult {
    /** 代码产生的输出（console.log 捕获） */
    output: string;
    /** 是否有错误 */
    error: boolean;
}

export interface SandboxExecuteOptions {
    /** CodeAct session/task scope. When set, JS top-level variables persist within that scope. */
    scopeId?: string;
}

/** 发给远端 sandboxd 的会话参数（握手由 transport 层完成） */
export interface RemoteSessionRequest {
    chatId: string;
    env: Record<string, string>;
    home: string;
    stateDir: string;
    shellPath: string;
}

export interface SandboxRuntimeConfig {
    mode: "local" | "remote";
    /** 遗留开关：worker / PTY 继承宿主完整 process.env（默认 false：只注入白名单 + sandbox 作用域变量） */
    inheritHostEnv?: boolean;
    /** 允许 agent 编写的 skill 经 skills.syncBack 回传 host（仅 remote） */
    skillsSyncBack?: boolean;
    /** worker 就绪超时（remote 冷启动更慢） */
    readyTimeoutMs?: number;
    /**
     * OS 级执行（bash / shell / child_process）。仅显式 false 时关闭；
     * 生产路径由 buildSandboxRuntime 依据 sandbox.process_exec 显式设置（默认 false）。
     */
    processExec?: boolean;
    limits?: Partial<ProtocolLimits>;
    remote?: {
        /**
         * 建立到 sandboxd 的会话；返回握手完成后的字节流与 sandbox 内实际 home。
         * release（可选）在会话结束时调用一次（临时 VM 模式下用于删除 VM）。
         */
        openSession: (request: RemoteSessionRequest) => Promise<{ socket: Duplex; home: string; release?: () => Promise<void> }>;
        pingIntervalMs?: number;
    };
}

/** 宿主可安全透传给 sandbox 的环境变量（不含任何凭据） */
const BASE_ENV_KEYS = ["LANG", "LC_ALL", "TZ", "NODE_ENV", "LOG_LEVEL", "TMPDIR"];

interface HostCallHandler {
    (method: string, args: unknown[]): Promise<unknown> | unknown;
}

interface PendingRequest {
    resolve: (result: ExecutionResult) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

interface PendingOp {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * Sandbox — 代码执行沙箱的 Host 侧管理器
 *
 * Events:
 * - "notify" — 来自 agent 的 runtime.notify() 事件（已经 notify-guard 过滤）
 * - "print" — 来自 agent 的 runtime.print() 直接输出
 * - "input_request" — 来自 agent 的 runtime.input() 请求（含 id 和 prompt）
 * - "stderr" — worker 的 stderr 输出
 * - "exit" — sandbox 会话结束（worker 退出或连接断开）
 * - "error" — 传输错误
 * - "shell_wake" — shell.runBackground 后台命令完成 / 空闲 / 硬超时
 * - "ready" — 会话就绪（start() resolve 之前触发）
 *
 * @example
 * ```ts
 * const sandbox = new Sandbox();
 * await sandbox.start();
 * const result = await sandbox.execute('console.log("hello")', 5000);
 * ```
 */
export class Sandbox extends EventEmitter {
    private input: Readable | null = null;
    private output: Writable | null = null;
    private closeTransport: (() => void) | null = null;
    private supervisor: SupervisorCore | null = null;
    private rl: LineReader | null = null;
    private alive = false;
    private stopping = false;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private pendingOps: Map<string, PendingOp> = new Map();
    private readyWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
    private requestCounter = 0;
    private projectRoot: string;
    private hostCallHandler: HostCallHandler | null = null;
    /** 仅注入 sandbox 的额外环境变量 */
    private sandboxEnv: Record<string, string>;
    /** 仅限 host 的环境变量 key 列表（从 sandbox env 中剔除） */
    private hostOnlyKeys: string[];
    private readonly runtime: SandboxRuntimeConfig;
    /** 当前 session 待消费的轮次增量（由 worker runtime.extendSteps 上报） */
    private pendingExtendedSteps = 0;
    /** 当前 session 待消费的超时覆盖（由 worker runtime.modifyTimeout 上报） */
    private pendingTimeoutOverrideMs: number | null = null;
    /** supervisor 上报的后台 shell 任务数（hasActiveBackgroundTasks 需同步返回） */
    private activeBackground = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private exitEmitted = false;
    /** chatId（用于创建 per-chat 状态目录） */
    private chatId: string;
    /** remote 会话握手时 sandboxd 报告的实际 home */
    private remoteHome: string | null = null;
    /** 会话结束时释放远端资源（临时 VM） */
    private releaseRemote: (() => Promise<void>) | null = null;
    /** 正在进行的远端资源释放（如删除 ephemeral VM）；stop() 等待它完成，避免进程退出时请求丢失 */
    private pendingRelease: Promise<void> | null = null;

    /** 协议上限（host 侧强制，sandbox 视为不可信） */
    private readonly limits: ProtocolLimits;
    /**
     * host 成功替本 sandbox 执行写操作时授予凭证；worker 上报的 agent_message_sent 必须消耗凭证。
     * 由 host-call-handler 写入，notify 过滤读取。
     */
    readonly sendLedger = new SendLedger();
    /** 正在处理的 host_call 数量 */
    private activeHostCalls = 0;
    /** notify / print / stderr 令牌桶 */
    private eventTokens: number = PROTOCOL_LIMITS.eventBurst;
    private eventTokensUpdatedAt = Date.now();
    private droppedEventCount = 0;
    /** 最近一分钟的无效帧计数 */
    private invalidFrameTimestamps: number[] = [];

    constructor(
        projectRoot?: string,
        chatId?: string,
        sandboxEnv?: Record<string, string>,
        hostOnlyKeys?: string[],
        runtime?: SandboxRuntimeConfig,
    ) {
        super();
        // __dirname = src/sandbox/, need to go up 2 levels to reach project root
        this.projectRoot = projectRoot ?? join(__dirname, "..", "..");
        this.chatId = chatId ?? "default";
        this.sandboxEnv = sandboxEnv ?? {};
        this.hostOnlyKeys = hostOnlyKeys ?? [];
        this.runtime = runtime ?? { mode: "local" };
        this.limits = resolveLimits(this.runtime.limits);
    }

    isRemote(): boolean {
        return this.runtime.mode === "remote";
    }

    getChatId(): string {
        return this.chatId;
    }

    /** sandbox 内 agent 的 home（worker cwd） */
    getSandboxHome(): string {
        return this.isRemote() ? (this.remoteHome ?? REMOTE_SANDBOX_HOME) : join(this.projectRoot, "workspace");
    }

    private getStateDir(): string {
        const safeChatId = this.chatId.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
        return this.isRemote()
            ? join(REMOTE_SANDBOX_HOME, ".sandbox-state")
            : join(this.projectRoot, "workspace", "sessions", ".sandbox-state", safeChatId);
    }

    private getSkillsDir(): string {
        return join(this.getSandboxHome(), "skills");
    }

    /**
     * 热更新 sandbox 可见环境变量（对现有 worker + PTY 即时生效，并影响后续重启）
     */
    async applyManagedEnv(sandboxVisibleEnv: Record<string, string>, managedKeys: string[]): Promise<void> {
        this.sandboxEnv = { ...sandboxVisibleEnv };
        this.hostOnlyKeys = managedKeys.filter((k) => !(k in sandboxVisibleEnv));

        if (!this.isAlive()) return;

        const set: Record<string, string> = {};
        const unset: string[] = [];
        for (const key of managedKeys) {
            if (key in sandboxVisibleEnv) {
                set[key] = String(sandboxVisibleEnv[key]);
            } else {
                unset.push(key);
            }
        }

        try {
            await this.request({ type: "env_patch", set, unset }, 10_000);
        } catch (err) {
            log.warn("sandbox env 热更新失败", { chatId: this.chatId, error: String(err) });
        }
    }

    /**
     * 构建 sandbox env：白名单基础变量 + sandbox 作用域变量，剔除 hostOnlyKeys。
     * 默认不继承宿主 process.env（宿主中有 bot token / API key 等凭据）。
     */
    private buildWorkerEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        if (this.runtime.inheritHostEnv && !this.isRemote()) {
            for (const [k, v] of Object.entries(process.env)) {
                if (v !== undefined) env[k] = v;
            }
        } else {
            for (const key of BASE_ENV_KEYS) {
                const value = process.env[key];
                if (value !== undefined && !(this.isRemote() && key === "TMPDIR")) env[key] = value;
            }
            env.PATH = this.isRemote() ? REMOTE_SANDBOX_PATH : (process.env.PATH ?? "");
            env.CI = "true";
            env.NO_COLOR = "1";
            env.FORCE_COLOR = "0";
            env.TERM = "dumb";
            if (!env.LANG) env.LANG = "C.UTF-8";
        }
        // 注入 sandbox 专属环境变量
        for (const [k, v] of Object.entries(this.sandboxEnv)) {
            env[k] = v;
        }
        // 剔除仅限 host 的环境变量
        for (const key of this.hostOnlyKeys) {
            delete env[key];
        }
        env.HOME = this.getSandboxHome();
        env.SANDBOX_CHAT_ID = this.chatId;
        env.SANDBOX_SKILLS_DIR = this.getSkillsDir();
        // ctx 持久化路径：per-chat 状态文件
        env.SANDBOX_CTX_PATH = join(this.getStateDir(), "ctx.json");
        if (this.isRemote()) env.SANDBOX_NO_NETWORK = "1";
        else delete env.SANDBOX_NO_NETWORK;
        // 最后写入：不允许 sandbox 作用域变量覆盖
        if (this.isProcessExecDisabled()) env.SANDBOX_NO_PROCESS_EXEC = "1";
        else delete env.SANDBOX_NO_PROCESS_EXEC;
        if (this.isRemote() && this.runtime.skillsSyncBack) env.SANDBOX_SKILLS_SYNC_BACK = "1";
        else delete env.SANDBOX_SKILLS_SYNC_BACK;
        return env;
    }

    /**
     * 启动 sandbox 会话（worker + default PTY）
     */
    async start(): Promise<void> {
        if (this.alive || this.input) {
            throw new Error("Sandbox already started");
        }
        this.stopping = false;
        this.exitEmitted = false;
        this.activeBackground = 0;

        const env = this.buildWorkerEnv();
        const home = this.getSandboxHome();
        const stateDir = this.getStateDir();
        const skillsDir = this.getSkillsDir();
        const shellPath = this.isRemote()
            ? buildShellPath(home, skillsDir, [], env.PATH)
            : buildShellPath(home, skillsDir, getAgentSkillScriptDirsIn(skillsDir), env.PATH);
        const readyTimeoutMs = this.runtime.readyTimeoutMs ?? (this.isRemote() ? 30_000 : 10_000);

        // 就绪计时从传输建立后开始：远程（尤其 ephemeral VM）的开机 / 连接耗时由 openSession 自己的超时控制
        const armReady = () => {
            const ready = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.readyWaiter = null;
                    reject(new Error(`Sandbox did not become ready within ${readyTimeoutMs}ms`));
                }, readyTimeoutMs + 2_000);
                this.readyWaiter = {
                    resolve: () => { clearTimeout(timer); resolve(); },
                    reject: (err) => { clearTimeout(timer); reject(err); },
                };
            });
            // 若在等待前就失败，避免未处理的 rejection
            ready.catch(() => undefined);
            return ready;
        };
        let ready: Promise<void>;

        if (this.isRemote()) {
            const remote = this.runtime.remote;
            if (!remote) throw new Error("sandbox.mode=remote 但未配置 remote transport");
            const session = await remote.openSession({ chatId: this.chatId, env, home, stateDir, shellPath });
            ready = armReady();
            const socket = session.socket;
            this.remoteHome = session.home;
            this.releaseRemote = session.release ?? null;
            this.attachTransport(socket, socket, () => socket.destroy());
            // 立即开始心跳：sandboxd 按"host 多久没发字节"回收会话，冷启动期间也必须保持活跃
            this.startPing();
            socket.on("error", (err) => {
                log.warn("sandbox 远程连接错误", { chatId: this.chatId, error: String(err) });
                if (this.listenerCount("error") > 0) this.emit("error", err);
            });
            socket.once("close", () => this.handleSessionEnd("connection closed"));
        } else {
            ready = armReady();
            const hostToSupervisor = new PassThrough();
            const supervisorToHost = new PassThrough();
            this.attachTransport(supervisorToHost, hostToSupervisor, () => {
                void this.supervisor?.dispose();
            });
            supervisorToHost.once("end", () => this.handleSessionEnd("supervisor ended"));
            const supervisor = new SupervisorCore(hostToSupervisor, supervisorToHost, {
                chatId: this.chatId,
                home,
                stateDir,
                env,
                shellPath,
                projectRoot: this.projectRoot,
                readyTimeoutMs,
            });
            this.supervisor = supervisor;
            supervisor.start().catch((err) => {
                this.readyWaiter?.reject(err instanceof Error ? err : new Error(String(err)));
                this.readyWaiter = null;
            });
        }

        try {
            await ready;
        } catch (err) {
            await this.stop().catch(() => undefined);
            throw err;
        }

    }

    private startPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        const interval = this.runtime.remote?.pingIntervalMs ?? 15_000;
        const ping = () => this.writeFrame({ type: "ping", id: `ping_${++this.requestCounter}` });
        ping();
        this.pingTimer = setInterval(ping, interval);
        this.pingTimer.unref?.();
    }

    private attachTransport(input: Readable, output: Writable, close: () => void): void {
        this.input = input;
        this.output = output;
        this.closeTransport = close;
        this.alive = true;
        output.on?.("error", () => { /* 对端已关闭：由 session end 统一处理 */ });
        this.rl = createLineReader(input, {
            maxLineBytes: this.limits.maxLineBytes,
            onLine: (line) => this.handleWorkerMessage(line),
            onViolation: (reason) => this.terminateForProtocolViolation(reason),
        });
    }

    /** 会话结束（worker 退出 / 连接断开 / supervisor 结束）：拒绝所有挂起请求，emit exit */
    private handleSessionEnd(reason: string, code: number | null = null, signal: string | null = null): void {
        const wasAlive = this.alive;
        this.alive = false;
        this.activeBackground = 0;
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        const err = new Error(`Sandbox worker exited (${reason}, code=${code}, signal=${signal})`);
        if (this.readyWaiter) {
            this.readyWaiter.reject(err);
            this.readyWaiter = null;
        }
        for (const [id, req] of this.pendingRequests) {
            if (req.timer) clearTimeout(req.timer);
            req.reject(new Error(`${err.message} while request ${id} was pending`));
        }
        this.pendingRequests.clear();
        for (const [, op] of this.pendingOps) {
            if (op.timer) clearTimeout(op.timer);
            op.reject(err);
        }
        this.pendingOps.clear();
        const hadTransport = this.input !== null;
        const release = this.releaseRemote;
        this.releaseRemote = null;
        if (release) {
            const pending = release()
                .catch((err) => log.warn("释放远端 sandbox 资源失败", { chatId: this.chatId, error: String(err) }))
                .finally(() => { if (this.pendingRelease === pending) this.pendingRelease = null; });
            this.pendingRelease = pending;
        }
        this.rl?.dispose();
        this.rl = null;
        this.input = null;
        this.output = null;
        if (!this.exitEmitted && (wasAlive || hadTransport)) {
            this.exitEmitted = true;
            const expected = this.stopping;
            const logFn = expected ? log.debug.bind(log) : log.warn.bind(log);
            logFn("Sandbox session ended", { chatId: this.chatId, reason, code, signal });
            this.emit("exit", code, signal);
        }
    }

    /**
     * 处理 sandbox 发来的消息（worker 帧经 supervisor 转发 + supervisor 自身帧）
     */
    private handleWorkerMessage(line: string): void {
        if (!line.trim()) return;
        const parsed = parseWorkerFrame(safeParseJson(line), this.limits);
        if (!parsed.ok) {
            this.recordInvalidFrame(parsed.reason);
            return;
        }
        const msg: WorkerFrame = parsed.frame;

        switch (msg.type) {
            case "result": {
                if (msg.extendSteps) {
                    this.pendingExtendedSteps = Math.min(
                        this.pendingExtendedSteps + msg.extendSteps,
                        this.limits.maxExtendSteps,
                    );
                }
                if (msg.timeoutMs) {
                    this.pendingTimeoutOverrideMs = msg.timeoutMs;
                }
                const pending = this.pendingRequests.get(msg.id);
                if (pending) {
                    this.pendingRequests.delete(msg.id);
                    if (pending.timer) clearTimeout(pending.timer);
                    pending.resolve({ output: msg.output, error: msg.error });
                }
                return;
            }
            case "shell_result": {
                const pending = this.pendingRequests.get(msg.id);
                if (pending) {
                    this.pendingRequests.delete(msg.id);
                    if (pending.timer) clearTimeout(pending.timer);
                    pending.resolve({ output: msg.output, error: msg.error });
                }
                return;
            }
            case "op_result": {
                const op = this.pendingOps.get(msg.id);
                if (!op) return;
                this.pendingOps.delete(msg.id);
                if (op.timer) clearTimeout(op.timer);
                if (msg.ok) op.resolve(msg.value);
                else op.reject(new Error(msg.error ?? "sandbox operation failed"));
                return;
            }
            case "notify": {
                if (!this.takeEventToken()) return;
                if (jsonByteLength(msg.event) > this.limits.maxNotifyBytes) {
                    log.warn("丢弃超大 sandbox notify 事件", { chatId: this.chatId });
                    return;
                }
                const guarded = guardSandboxNotify(msg.event, { boundChatId: this.chatId, ledger: this.sendLedger });
                if (!guarded.ok) {
                    log.warn("拦截 sandbox notify 事件", { chatId: this.chatId, reason: guarded.reason });
                    return;
                }
                this.emit("notify", guarded.event);
                return;
            }
            case "input_request":
                // Agent 请求用户输入
                if (!msg.prompt) return;
                this.emit("input_request", { id: msg.id, prompt: msg.prompt });
                return;
            case "print":
                // Agent 直接打印
                if (!msg.message || !this.takeEventToken()) return;
                this.emit("print", msg.message);
                return;
            case "host_call":
                void this.handleHostCall(msg.id, msg.method, msg.args);
                return;
            case "ready":
                this.readyWaiter?.resolve();
                this.readyWaiter = null;
                this.emit("ready");
                return;
            case "shell_state":
                this.activeBackground = msg.activeBackground;
                return;
            case "shell_wake":
                this.emit("shell_wake", msg.event as ShellWakeEvent);
                return;
            case "stderr":
                if (!this.takeEventToken()) return;
                this.emit("stderr", msg.data);
                return;
            case "worker_exit":
                if (msg.error) log.warn("sandbox worker 启动失败", { chatId: this.chatId, error: msg.error });
                this.handleSessionEnd(msg.error ? `startup failed: ${msg.error}` : "worker exited", msg.code, msg.signal);
                this.closeTransport?.();
                return;
            case "pong":
                return;
            case "protocol_violation":
                this.terminateForProtocolViolation(msg.reason);
                return;
        }
    }

    /** notify / print / stderr 共用的令牌桶；耗尽时丢弃并定期汇总告警 */
    private takeEventToken(): boolean {
        const now = Date.now();
        const elapsed = (now - this.eventTokensUpdatedAt) / 1000;
        this.eventTokensUpdatedAt = now;
        this.eventTokens = Math.min(this.limits.eventBurst, this.eventTokens + elapsed * this.limits.eventRatePerSecond);
        if (this.eventTokens >= 1) {
            this.eventTokens -= 1;
            return true;
        }
        this.droppedEventCount++;
        if (this.droppedEventCount === 1 || this.droppedEventCount % 1000 === 0) {
            log.warn("sandbox 事件超出速率上限，已丢弃", { chatId: this.chatId, dropped: this.droppedEventCount });
        }
        return false;
    }

    private recordInvalidFrame(reason: string): void {
        const now = Date.now();
        this.invalidFrameTimestamps = this.invalidFrameTimestamps.filter((t) => now - t < 60_000);
        this.invalidFrameTimestamps.push(now);
        log.warn("sandbox 发送了无效帧", { chatId: this.chatId, reason: reason.slice(0, 200) });
        if (this.invalidFrameTimestamps.length > this.limits.maxInvalidFramesPerMinute) {
            this.terminateForProtocolViolation("too_many_invalid_frames");
        }
    }

    /** 协议违规：不尝试恢复，直接终止会话（pool 会在下次 acquire 时重建） */
    private terminateForProtocolViolation(reason: string): void {
        if (this.stopping || !this.alive) return;
        log.error("sandbox 协议违规，终止会话", { chatId: this.chatId, reason });
        void this.stop().catch((err) => {
            log.warn("协议违规后停止 sandbox 失败", { chatId: this.chatId, error: String(err) });
        });
    }

    /**
     * 向 sandbox 写一帧，对"正在停止 / 管道已关闭"做防御（结果本就无人接收）。
     */
    private writeFrame(frame: Record<string, unknown>): boolean {
        const out = this.output;
        if (this.stopping || !this.alive || !out || out.destroyed || out.writableEnded) {
            return false;
        }
        try {
            return out.write(JSON.stringify(frame) + "\n");
        } catch {
            return false;
        }
    }

    private async handleHostCall(id: string, method: string, args: unknown[]): Promise<void> {
        if (!this.alive) return;

        let admitted = false;
        try {
            if (!this.hostCallHandler) {
                throw new Error(`No host call handler registered for ${method}`);
            }
            if (this.activeHostCalls >= this.limits.maxConcurrentHostCalls) {
                throw new Error(`[Sandbox 限制] 同时进行的 host 调用超过 ${this.limits.maxConcurrentHostCalls} 个，请 await 之前的调用后重试`);
            }
            if (jsonByteLength(args) > this.limits.maxHostCallArgsBytes) {
                throw new Error(`[Sandbox 限制] ${method} 参数超过 ${this.limits.maxHostCallArgsBytes} 字节`);
            }
            this.activeHostCalls++;
            admitted = true;

            const value = normalizeProgrammaticTimestamps(await this.hostCallHandler(method, args));
            this.writeFrame({ type: "host_call_result", id, ok: true, value });
        } catch (err) {
            this.writeFrame({
                type: "host_call_result",
                id,
                ok: false,
                method,
                error: err instanceof Error ? err.message : String(err),
                ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
            });
        } finally {
            if (admitted) this.activeHostCalls--;
        }
    }

    private nextId(): string {
        return `req_${++this.requestCounter}`;
    }

    /** 发送控制请求并等待 op_result */
    private request(frame: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
        if (!this.alive) return Promise.reject(new Error("Sandbox worker is not running"));
        const id = this.nextId();
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingOps.delete(id);
                reject(new Error(`Sandbox operation ${String(frame.type)} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pendingOps.set(id, { resolve, reject, timer });
            if (!this.writeFrame({ ...frame, id }) && !this.alive) {
                clearTimeout(timer);
                this.pendingOps.delete(id);
                reject(new Error("Sandbox worker is not running"));
            }
        });
    }

    /**
     * 在 sandbox 中执行代码
     */
    async execute(code: string, timeout: number = 30000, options?: SandboxExecuteOptions): Promise<ExecutionResult> {
        if (!this.alive) {
            throw new Error("Sandbox worker is not running");
        }

        const id = this.nextId();

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                const error = new Error(`Code execution timed out after ${timeout}ms`);
                log.warn("execute: timeout, stopping sandbox worker", {
                    chatId: this.chatId,
                    requestId: id,
                    timeoutMs: timeout,
                });
                reject(error);
                void this.stop().catch((err) => {
                    log.warn("execute: failed to stop timed-out sandbox worker", {
                        chatId: this.chatId,
                        requestId: id,
                        error: String(err),
                    });
                });
            }, timeout);

            this.pendingRequests.set(id, { resolve, reject, timer });

            this.writeFrame({
                type: "execute",
                id,
                code,
                ...(options?.scopeId ? { scopeId: options.scopeId } : {}),
            });
        });
    }

    /**
     * 清理一个 CodeAct task-scoped notebook namespace。
     */
    async resetNotebookScope(scopeId: string, timeout: number = 5000): Promise<void> {
        if (!this.alive) {
            throw new Error("Sandbox worker is not running");
        }

        const id = this.nextId();
        await new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Notebook scope reset timed out after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(id, { resolve, reject, timer });
            this.writeFrame({ type: "reset_scope", id, scopeId });
        });
    }

    /**
     * 在 PTY shell 中执行命令（持久化交互式 shell）
     *
     * 使用 sentinel 标记检测命令完成，提取输出、退出码和当前 cwd。
     * 结果末尾附加 [cwd: /current/path]。超时不抛错，返回带超时标记的部分输出。
     */
    async executeShell(command: string, timeout: number = 30000): Promise<ExecutionResult> {
        this.assertProcessExec();
        if (!this.alive) {
            throw new Error("Sandbox worker is not running");
        }
        const id = this.nextId();
        return new Promise<ExecutionResult>((resolve, reject) => {
            // supervisor 侧自带超时处理；这里留出余量兜底对端失联
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Shell command did not return within ${timeout + 10_000}ms`));
            }, timeout + 10_000);
            this.pendingRequests.set(id, { resolve, reject, timer });
            this.writeFrame({ type: "shell_exec", id, command, timeoutMs: timeout });
        });
    }

    /**
     * 非阻塞地在独立后台终端启动一条命令，立即返回 tabId。
     *
     * 命令在后台运行，agent 可继续处理其它事务。sandbox 侧监视器会在
     * 命令完成 / 空闲超时 / 达到硬上限时发出 "shell_wake"（由 main 侧
     * 转成一个新的唤醒任务）。三种情况都不会 kill 进程。
     */
    async runShellBackground(
        command: string,
        opts?: { tabId?: string; idleTimeout?: number; maxDuration?: number },
    ): Promise<{ tabId: string }> {
        this.assertProcessExec();
        const value = await this.request({ type: "shell_run_background", command, opts: opts ?? {} });
        const tabId = value && typeof value === "object" ? (value as { tabId?: unknown }).tabId : undefined;
        if (typeof tabId !== "string") throw new Error("shell.runBackground: invalid response from sandbox");
        return { tabId: tabId.slice(0, 128) };
    }

    /**
     * 发送用户输入响应到 worker（回应 runtime.input()）
     */
    sendInputResponse(id: string, value: string): void {
        if (!this.alive) {
            throw new Error("Sandbox worker is not running");
        }
        this.writeFrame({ type: "input_response", id, value });
    }

    /**
     * 注册 worker 侧 host_call 的处理函数。
     *
     * 用于把 sandbox 中的 runtime/todo/skills 等能力代理到 host 进程中的真实实现。
     */
    setHostCallHandler(handler: HostCallHandler): void {
        this.hostCallHandler = handler;
    }

    isAlive(): boolean {
        return !this.stopping && this.alive;
    }

    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        const supervisor = this.supervisor;
        const close = this.closeTransport;
        this.closeTransport = null;
        try { close?.(); } catch { /* ignore */ }
        if (supervisor) {
            await Promise.race([
                supervisor.dispose(),
                new Promise<void>((resolve) => setTimeout(resolve, 4000)),
            ]);
        }
        this.handleSessionEnd("stopped");
        this.supervisor = null;
        // 等远端资源释放完成（有上限）：进程关停时若不等，删除 VM 的请求会随进程退出丢失，VM 成为孤儿
        const pendingRelease = this.pendingRelease;
        if (pendingRelease) {
            await Promise.race([pendingRelease, new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref?.())]);
        }
        this.stopping = false;
    }

    // ─── Shell Tab 管理（供 shell 模块 host call 使用） ───

    /** OS 级执行是否被关闭（sandbox.process_exec=false） */
    isProcessExecDisabled(): boolean {
        return this.runtime.processExec === false;
    }

    private assertProcessExec(): void {
        if (this.isProcessExecDisabled()) {
            throw new Error("[Sandbox 安全限制] bash / shell 已禁用（sandbox.process_exec=false）");
        }
    }

    private async shellOp(op: string, ...args: unknown[]): Promise<unknown> {
        this.assertProcessExec();
        return this.request({ type: "shell_op", op, args });
    }

    async listShellTabs(): Promise<ShellTabInfo[]> {
        const value = await this.shellOp("list");
        if (!Array.isArray(value)) return [];
        return value.slice(0, 16).map((item) => {
            const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
            return {
                id: String(rec.id ?? "").slice(0, 128),
                state: rec.state === "busy" ? "busy" : "idle",
                recentOutput: String(rec.recentOutput ?? "").slice(0, 500),
            };
        });
    }

    async detachDefaultTab(newTabId: string): Promise<void> {
        await this.shellOp("detach", newTabId);
    }

    async readShellTab(tabId?: string, lines?: number): Promise<string> {
        const value = await this.shellOp("read", tabId ?? null, lines ?? null);
        return truncateText(String(value ?? ""), this.limits.maxOutputChars);
    }

    /**
     * 是否有正在运行的后台 shell.runBackground 命令。
     * 供 SandboxPool 判断：有后台命令在跑时不应空闲回收（否则会静默 kill）。
     */
    hasActiveBackgroundTasks(): boolean {
        return this.alive && this.activeBackground > 0;
    }

    async sendShellInput(input: string, tabId?: string): Promise<void> {
        await this.shellOp("send_input", input, tabId ?? null);
    }

    async killShellTab(tabId?: string): Promise<void> {
        await this.shellOp("kill", tabId ?? null);
    }

    async getShellCwd(): Promise<string> {
        const value = await this.shellOp("cwd");
        return String(value ?? "").slice(0, 4096);
    }

    // ─── 文件传输（host ⇄ sandbox home） ───

    /** 读取 sandbox 内文件的一个分块 */
    async readFileChunk(path: string, offset: number, length: number): Promise<{ data: Buffer; eof: boolean; size: number }> {
        const value = await this.request({ type: "fs_read", path, offset, length }) as Record<string, unknown> | null;
        if (!value || typeof value.base64 !== "string") throw new Error("invalid fs_read response");
        return {
            data: Buffer.from(value.base64, "base64"),
            eof: value.eof === true,
            size: typeof value.size === "number" ? value.size : 0,
        };
    }

    /** 写入 sandbox 内文件（append=false 覆盖） */
    async writeFileChunk(path: string, data: Buffer, append: boolean): Promise<void> {
        await this.request({ type: "fs_write", path, base64: data.toString("base64"), append });
    }

    async listFiles(path: string): Promise<string[]> {
        const value = await this.request({ type: "fs_list", path });
        return Array.isArray(value) ? value.slice(0, 500).map((v) => String(v).slice(0, 1024)) : [];
    }

    async statFile(path: string): Promise<{ size: number; isFile: boolean; path: string } | null> {
        const value = await this.request({ type: "fs_stat", path }) as Record<string, unknown> | null;
        if (!value || typeof value !== "object") return null;
        return {
            size: typeof value.size === "number" ? value.size : 0,
            isFile: value.isFile === true,
            path: String(value.path ?? path),
        };
    }

    /**
     * 取出并清空本次执行累计的控制指令（仅当前 session 使用）
     */
    consumeExecutionControl(): { extendSteps: number; timeoutMs: number | null } {
        const control = {
            extendSteps: this.pendingExtendedSteps,
            timeoutMs: this.pendingTimeoutOverrideMs,
        };
        this.pendingExtendedSteps = 0;
        this.pendingTimeoutOverrideMs = null;
        return control;
    }

}
