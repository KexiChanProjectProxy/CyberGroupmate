/**
 * session-launcher.ts — sandboxd 为每个 session 启动 supervisor
 *
 * - DockerLauncher（生产）：每个 session 一个容器：--network none、只读 rootfs、cap-drop ALL、
 *   no-new-privileges、pids / memory / cpu 限额，默认 gVisor（runsc）runtime。
 * - ProcessLauncher（开发 / 测试）：直接在本机启动 supervisor 进程，无隔离。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxdConfig } from "./sandboxd-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

/** 容器内固定路径 */
export const CONTAINER_HOME = "/home/agent";
export const CONTAINER_SKILLS = "/opt/skills";

export interface LaunchRequest {
    sessionId: string;
    chatKey: string;
    /** sandbox VM 上该 chat 的 home 目录 */
    homeDir: string;
    /** sandbox VM 上该 session 使用的 skills generation 目录（可选） */
    skillsDir: string | null;
}

export interface LaunchedSession {
    child: ChildProcess;
    /** supervisor 视角的 home 路径 */
    home: string;
    /** supervisor 视角的 skills 源目录 */
    skillsSource: string | null;
    kill(): void;
}

export interface SessionLauncher {
    launch(req: LaunchRequest): LaunchedSession;
    /** 启动时清理上次遗留的 session */
    pruneOrphans(): void;
}

export class ProcessLauncher implements SessionLauncher {
    constructor(private readonly projectRoot: string = PROJECT_ROOT) {}

    launch(req: LaunchRequest): LaunchedSession {
        const tsxCli = join(this.projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
        const main = join(this.projectRoot, "src", "sandbox", "supervisor", "main.ts");
        if (!existsSync(tsxCli)) throw new Error(`tsx not found at ${tsxCli}`);
        const child = spawn(process.execPath, [tsxCli, main], {
            cwd: req.homeDir,
            stdio: ["pipe", "pipe", "pipe"],
            // 不继承 sandboxd 的环境；session env 由 session_init 传入
            env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: req.homeDir, LANG: "C.UTF-8" },
            detached: true,
        });
        return {
            child,
            home: req.homeDir,
            skillsSource: req.skillsDir,
            kill: () => {
                if (child.pid && child.exitCode === null) {
                    // 杀整个进程组（worker / bash 子进程）
                    try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
                }
            },
        };
    }

    pruneOrphans(): void {
        // 进程模式下 session 随 sandboxd 一起退出（detached 进程组在 sandboxd 退出时由 systemd KillMode 清理）
    }
}

export class DockerLauncher implements SessionLauncher {
    constructor(private readonly cfg: SandboxdConfig["docker"]) {}

    buildArgs(req: LaunchRequest): string[] {
        const d = this.cfg;
        const args = [
            "run", "-i", "--rm",
            "--name", containerName(req.sessionId),
            "--label", `sandboxd.session=${req.sessionId}`,
            "--label", `sandboxd.chat=${req.chatKey}`,
            ...(d.runtime ? ["--runtime", d.runtime] : []),
            "--network", "none",
            "--read-only",
            "--tmpfs", `/tmp:rw,nosuid,nodev,size=${d.tmpfs_size}`,
            "--mount", `type=bind,src=${req.homeDir},dst=${CONTAINER_HOME}`,
            ...(req.skillsDir ? ["--mount", `type=bind,src=${req.skillsDir},dst=${CONTAINER_SKILLS},readonly`] : []),
            "--user", d.user,
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--pids-limit", String(d.pids_limit),
            // "0"：不设上限（临时 VM 一台只服务一个 chat，以 VM 规格为界）
            ...(d.memory && d.memory !== "0" ? ["--memory", d.memory, "--memory-swap", d.memory] : []),
            ...(d.cpus && d.cpus !== "0" ? ["--cpus", d.cpus] : []),
            "--ulimit", "core=0",
            "--ulimit", `nofile=${d.nofile}:${d.nofile}`,
            "--init",
            "--stop-timeout", "3",
            "--log-driver", "none",
            "-w", CONTAINER_HOME,
            ...d.extra_args,
            d.image,
        ];
        return args;
    }

    launch(req: LaunchRequest): LaunchedSession {
        const child = spawn(this.cfg.bin, this.buildArgs(req), {
            stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        });
        const name = containerName(req.sessionId);
        return {
            child,
            home: CONTAINER_HOME,
            skillsSource: req.skillsDir ? CONTAINER_SKILLS : null,
            kill: () => {
                spawn(this.cfg.bin, ["rm", "-f", name], { stdio: "ignore" }).on("error", () => undefined);
                try { child.kill("SIGKILL"); } catch { /* ignore */ }
            },
        };
    }

    pruneOrphans(): void {
        const list = spawnSync(this.cfg.bin, ["ps", "-aq", "--filter", "label=sandboxd.session"], { encoding: "utf-8" });
        const ids = (list.stdout ?? "").split(/\s+/).filter(Boolean);
        if (ids.length > 0) spawnSync(this.cfg.bin, ["rm", "-f", ...ids], { stdio: "ignore" });
    }
}

function containerName(sessionId: string): string {
    return `sbx-${sessionId}`;
}

export function createLauncher(cfg: SandboxdConfig): SessionLauncher {
    return cfg.launcher === "process" ? new ProcessLauncher() : new DockerLauncher(cfg.docker);
}
