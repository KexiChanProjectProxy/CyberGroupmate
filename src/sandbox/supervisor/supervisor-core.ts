/**
 * supervisor-core.ts — sandbox 侧会话监督者
 *
 * 持有 worker 子进程与全部 PTY tab，通过一条 NDJSON 双向流与 host 通信：
 * - local 模式：在 host 进程内运行，流是一对内存 PassThrough；
 * - remote 模式：在隔离容器内运行（supervisor/main.ts），流是容器 stdio ⇄ sandboxd ⇄ mTLS。
 *
 * supervisor 与 worker 处于同一信任域（同 uid，worker 可篡改 supervisor），
 * 因此它不承担任何安全职责：host 对 supervisor 发出的所有数据都按不可信处理。
 *
 * Host → Supervisor：
 *   execute / reset_scope / input_response / host_call_result  → 原样转发给 worker
 *   env_patch{id,set,unset}                                    → worker + PTY
 *   shell_exec{id,command,timeoutMs}                           → shell_result
 *   shell_run_background{id,command,opts}                      → op_result
 *   shell_op{id,op,args}                                       → op_result
 *   fs_read{id,path,offset,length} / fs_write / fs_stat / fs_list → op_result
 *   ping{id}                                                   → pong
 * Supervisor → Host：
 *   worker 帧原样转发（result / notify / print / input_request / host_call）
 *   ready / shell_result / op_result / shell_wake / shell_state / stderr / worker_exit / pong
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { open, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createLineReader, safeParseJson, truncateText, type LineReader } from "../protocol/ndjson.js";
import { PtyManager } from "../pty-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

/** supervisor 接收来自 host 的单行上限（host 可信，但仍防御异常数据） */
const MAX_HOST_LINE_BYTES = 16 * 1024 * 1024;
/** worker → supervisor 单行上限（与 host 侧一致，超出时 host 也会拒绝） */
const MAX_WORKER_LINE_BYTES = 4 * 1024 * 1024;
const FS_CHUNK_MAX = 1024 * 1024;
const STDERR_CHUNK_MAX = 16 * 1024;

export interface SupervisorOptions {
    chatId: string;
    /** agent home（worker cwd、PTY HOME、fs 根） */
    home: string;
    /** .bashrc / ctx.json / persistent-tasks.json 所在目录 */
    stateDir: string;
    /** worker / PTY 的完整环境变量（由 host 构建，不读 process.env） */
    env: Record<string, string>;
    /** PTY PATH */
    shellPath: string;
    noNetwork?: boolean;
    projectRoot?: string;
    /** worker ready 超时 */
    readyTimeoutMs?: number;
}

type HostFrame = Record<string, unknown> & { type?: unknown; id?: unknown };

const WORKER_FORWARD_TYPES = new Set(["execute", "reset_scope", "input_response", "host_call_result"]);

export class SupervisorCore {
    private worker: ChildProcess | null = null;
    private workerReader: LineReader | null = null;
    private hostReader: LineReader | null = null;
    private pty: PtyManager | null = null;
    private disposed = false;
    private internalCounter = 0;
    private internalPending = new Map<string, () => void>();
    private homeReal = "";
    /** 启动时固化：之后的 env_patch 不能重新打开 shell */
    private readonly processExecDisabled: boolean;

    constructor(
        private readonly input: Readable,
        private readonly output: Writable,
        private readonly opts: SupervisorOptions,
    ) {
        this.processExecDisabled = opts.env.SANDBOX_NO_PROCESS_EXEC === "1";
    }

    /** 启动 worker 与 default PTY，完成后发送 ready（或 worker_exit） */
    async start(): Promise<void> {
        const { home, stateDir } = this.opts;
        if (!existsSync(home)) mkdirSync(home, { recursive: true });
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        this.homeReal = realpathSync(home);

        this.hostReader = createLineReader(this.input, {
            maxLineBytes: MAX_HOST_LINE_BYTES,
            onLine: (line) => this.handleHostLine(line),
            onViolation: () => void this.dispose(),
        });
        this.input.once("end", () => void this.dispose());
        this.input.once("close", () => void this.dispose());

        const projectRoot = this.opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
        const workerPath = join(projectRoot, "src", "sandbox", "sandbox-worker.ts");
        const tsxCliPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
        if (!existsSync(tsxCliPath)) {
            throw new Error(`tsx runtime not found at ${tsxCliPath}. Did you run npm install?`);
        }

        const worker = spawn(process.execPath, [tsxCliPath, workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: home,
            env: this.opts.env,
        });
        this.worker = worker;
        worker.stdin?.on("error", () => { /* 管道已断：由 exit 统一处理 */ });
        worker.stderr?.on("data", (data: Buffer) => {
            this.send({ type: "stderr", data: truncateText(data.toString(), STDERR_CHUNK_MAX) });
        });

        const ready = new Promise<void>((resolveReady, rejectReady) => {
            const timer = setTimeout(
                () => rejectReady(new Error("Sandbox worker did not become ready in time")),
                this.opts.readyTimeoutMs ?? 10_000,
            );
            this.internalPending.set("__ready__", () => {
                clearTimeout(timer);
                resolveReady();
            });
            worker.once("exit", (code, signal) => {
                clearTimeout(timer);
                rejectReady(new Error(`Sandbox worker exited during startup (code=${code}, signal=${signal})`));
            });
            worker.once("error", (err) => {
                clearTimeout(timer);
                rejectReady(err);
            });
        });

        this.workerReader = createLineReader(worker.stdout!, {
            maxLineBytes: MAX_WORKER_LINE_BYTES,
            onLine: (line) => this.handleWorkerLine(line),
            // 交给 host 判定违规：发送一个超长标记行即可让 host 终止会话
            onViolation: () => this.send({ type: "protocol_violation", reason: "worker_line_too_long" }),
        });

        worker.on("exit", (code, signal) => {
            this.send({ type: "worker_exit", code, signal });
            void this.dispose();
        });

        try {
            await ready;
            if (this.processExecDisabled) {
                this.send({ type: "ready" });
                return;
            }
            this.pty = new PtyManager({
                chatId: this.opts.chatId,
                home,
                stateDir,
                env: this.opts.env,
                path: this.opts.shellPath,
                noNetwork: this.opts.noNetwork,
            });
            this.pty.on("shell_wake", (event) => this.send({ type: "shell_wake", event }));
            this.pty.on("state", (state: { activeBackground: number }) => this.send({ type: "shell_state", ...state }));
            await this.pty.start();
        } catch (err) {
            this.send({ type: "worker_exit", code: null, signal: null, error: err instanceof Error ? err.message : String(err) });
            await this.dispose();
            throw err;
        }
        this.send({ type: "ready" });
    }

    private send(frame: Record<string, unknown>): void {
        this.writeLine(JSON.stringify(frame));
    }

    private writeLine(line: string): void {
        if (this.output.destroyed || this.output.writableEnded) return;
        try {
            this.output.write(line + "\n");
        } catch { /* 对端已关闭 */ }
    }

    private writeToWorker(frame: Record<string, unknown>): void {
        const stdin = this.worker?.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) return;
        try {
            stdin.write(JSON.stringify(frame) + "\n");
        } catch { /* ignore */ }
    }

    private handleWorkerLine(line: string): void {
        // supervisor 内部请求（ready / env_patch）的 result 不转发给 host
        if (line.includes("\"__ready__\"") || line.includes("\"sup_")) {
            const msg = safeParseJson(line) as { type?: unknown; id?: unknown } | undefined;
            if (msg && msg.type === "result" && typeof msg.id === "string") {
                const internal = this.internalPending.get(msg.id);
                if (internal) {
                    this.internalPending.delete(msg.id);
                    internal();
                    return;
                }
            }
        }
        this.writeLine(line);
    }

    private handleHostLine(line: string): void {
        if (!line.trim()) return;
        const frame = safeParseJson(line) as HostFrame | undefined;
        if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
        if (WORKER_FORWARD_TYPES.has(frame.type)) {
            this.writeToWorker(frame);
            return;
        }
        const id = typeof frame.id === "string" ? frame.id : "";
        void this.handleControlFrame(frame, id);
    }

    private async handleControlFrame(frame: HostFrame, id: string): Promise<void> {
        try {
            switch (frame.type) {
                case "ping":
                    this.send({ type: "pong", id });
                    return;
                case "shell_exec": {
                    const pty = this.requirePty();
                    const result = await pty.exec(String(frame.command ?? ""), Number(frame.timeoutMs ?? 30_000));
                    this.send({ type: "shell_result", id, output: result.output, error: result.error });
                    return;
                }
                case "shell_run_background": {
                    const pty = this.requirePty();
                    const opts = (frame.opts && typeof frame.opts === "object" ? frame.opts : {}) as Record<string, unknown>;
                    const value = await pty.runBackground(String(frame.command ?? ""), {
                        tabId: typeof opts.tabId === "string" ? opts.tabId : undefined,
                        idleTimeout: typeof opts.idleTimeout === "number" ? opts.idleTimeout : undefined,
                        maxDuration: typeof opts.maxDuration === "number" ? opts.maxDuration : undefined,
                    });
                    this.reply(id, value);
                    return;
                }
                case "shell_op":
                    this.reply(id, await this.handleShellOp(String(frame.op ?? ""), Array.isArray(frame.args) ? frame.args : []));
                    return;
                case "env_patch": {
                    const set = (frame.set && typeof frame.set === "object" ? frame.set : {}) as Record<string, string>;
                    const unset = Array.isArray(frame.unset) ? frame.unset.map(String) : [];
                    for (const [k, v] of Object.entries(set)) this.opts.env[k] = String(v);
                    for (const k of unset) delete this.opts.env[k];
                    await this.requestWorker({ type: "env_patch", set, unset });
                    await this.pty?.applyEnv(set, unset);
                    this.reply(id, null);
                    return;
                }
                case "fs_read":
                    this.reply(id, await this.fsRead(String(frame.path ?? ""), Number(frame.offset ?? 0), Number(frame.length ?? FS_CHUNK_MAX)));
                    return;
                case "fs_write":
                    this.reply(id, await this.fsWrite(String(frame.path ?? ""), String(frame.base64 ?? ""), frame.append === true));
                    return;
                case "fs_stat":
                    this.reply(id, await this.fsStat(String(frame.path ?? "")));
                    return;
                case "fs_list":
                    this.reply(id, await this.fsList(String(frame.path ?? "")));
                    return;
                default:
                    this.send({ type: "op_result", id, ok: false, error: `unknown frame type: ${String(frame.type).slice(0, 64)}` });
            }
        } catch (err) {
            this.send({ type: "op_result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }

    private reply(id: string, value: unknown): void {
        this.send({ type: "op_result", id, ok: true, value: value ?? null });
    }

    private requirePty(): PtyManager {
        if (this.processExecDisabled) throw new Error("bash / shell 已禁用（sandbox.process_exec=false）");
        if (!this.pty) throw new Error("PTY not ready");
        return this.pty;
    }

    private async handleShellOp(op: string, args: unknown[]): Promise<unknown> {
        const pty = this.requirePty();
        const optStr = (v: unknown) => (v == null ? undefined : String(v));
        switch (op) {
            case "list": return pty.listTabs();
            case "detach": return pty.detachDefault(String(args[0] ?? ""));
            case "read": return pty.read(optStr(args[0]), args[1] == null ? undefined : Number(args[1]));
            case "send_input": pty.sendInput(String(args[0] ?? ""), optStr(args[1])); return null;
            case "kill": return pty.kill(optStr(args[0]));
            case "cwd": return pty.cwd();
            default: throw new Error(`unknown shell op: ${op.slice(0, 32)}`);
        }
    }

    private requestWorker(frame: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
        const id = `sup_${++this.internalCounter}`;
        return new Promise<void>((resolveReq) => {
            const timer = setTimeout(() => {
                this.internalPending.delete(id);
                resolveReq();
            }, timeoutMs);
            this.internalPending.set(id, () => {
                clearTimeout(timer);
                resolveReq();
            });
            this.writeToWorker({ ...frame, id });
        });
    }

    // ─── 文件操作（路径限制在 home 内） ───

    /** 把 host 传来的路径解析为 home 内的绝对路径（不跟随最终组件以外的检查交给 realpath） */
    private resolveInHome(p: string): string {
        if (!p || p.includes("\0")) throw new Error("invalid path");
        const abs = isAbsolute(p) ? resolve(p) : resolve(this.homeReal, p);
        const rel = relative(this.homeReal, abs);
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error("path outside sandbox home");
        }
        return abs;
    }

    private async assertRealInHome(abs: string): Promise<string> {
        const real = await realpath(abs);
        const rel = relative(this.homeReal, real);
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error("path outside sandbox home");
        }
        return real;
    }

    private async fsStat(p: string): Promise<{ size: number; isFile: boolean; path: string } | null> {
        let abs: string;
        try {
            abs = this.resolveInHome(p);
        } catch {
            return null;
        }
        try {
            const real = await this.assertRealInHome(abs);
            const st = await stat(real);
            return { size: st.size, isFile: st.isFile(), path: abs };
        } catch {
            return null;
        }
    }

    /** 递归列出目录下的普通文件（相对路径；跳过符号链接与 node_modules；最多 500 个） */
    private async fsList(p: string): Promise<string[]> {
        const root = await this.assertRealInHome(this.resolveInHome(p));
        const out: string[] = [];
        const walk = async (dir: string, prefix: string) => {
            const { readdir } = await import("node:fs/promises");
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (out.length >= 500) return;
                if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
                else if (entry.isFile()) out.push(rel);
            }
        };
        await walk(root, "");
        return out;
    }

    private async fsRead(p: string, offset: number, length: number): Promise<{ base64: string; eof: boolean; size: number }> {
        const real = await this.assertRealInHome(this.resolveInHome(p));
        const handle = await open(real, "r");
        try {
            const st = await handle.stat();
            if (!st.isFile()) throw new Error("not a file");
            const start = Math.max(0, Math.floor(offset) || 0);
            const len = Math.max(0, Math.min(FS_CHUNK_MAX, Math.floor(length) || FS_CHUNK_MAX));
            const buffer = Buffer.alloc(Math.min(len, Math.max(0, st.size - start)));
            const { bytesRead } = buffer.length > 0 ? await handle.read(buffer, 0, buffer.length, start) : { bytesRead: 0 };
            return {
                base64: buffer.subarray(0, bytesRead).toString("base64"),
                eof: start + bytesRead >= st.size,
                size: st.size,
            };
        } finally {
            await handle.close();
        }
    }

    private async fsWrite(p: string, base64: string, append: boolean): Promise<{ path: string; size: number }> {
        const abs = this.resolveInHome(p);
        await mkdir(dirname(abs), { recursive: true });
        await this.assertRealInHome(dirname(abs));
        try {
            if (lstatSync(abs).isSymbolicLink()) throw new Error("refusing to write through a symlink");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const data = Buffer.from(base64, "base64");
        const handle = await open(abs, append ? "a" : "w");
        try {
            await handle.write(data);
            const st = await handle.stat();
            return { path: abs, size: st.size };
        } finally {
            await handle.close();
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.hostReader?.dispose();
        this.workerReader?.dispose();
        this.pty?.dispose();
        this.pty = null;
        for (const [, done] of this.internalPending) done();
        this.internalPending.clear();
        const worker = this.worker;
        if (worker && worker.exitCode === null && worker.signalCode === null) {
            await new Promise<void>((resolveExit) => {
                const timer = setTimeout(() => {
                    try { worker.kill("SIGKILL"); } catch { /* ignore */ }
                    resolveExit();
                }, 3000);
                worker.once("exit", () => {
                    clearTimeout(timer);
                    resolveExit();
                });
                try { worker.kill("SIGTERM"); } catch { /* ignore */ }
            });
        }
        this.worker = null;
        try { this.output.end(); } catch { /* ignore */ }
    }
}
