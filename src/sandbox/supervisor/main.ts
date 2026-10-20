/**
 * supervisor/main.ts — remote 模式下容器内的 supervisor 入口
 *
 * stdin 第一行是 sandboxd 写入的 session_init；之后 stdin / stdout 即为与 host 的 NDJSON 流。
 * stdout 是协议通道：所有日志必须写 stderr。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { configureLogger, createLogger } from "../../core/logger.js";
import { safeParseJson } from "../protocol/ndjson.js";
import { readHandshakeLines } from "../remote/handshake.js";
import { SupervisorCore } from "./supervisor-core.js";

configureLogger({ sink: (line) => process.stderr.write(line + "\n"), color: false });
const log = createLogger("supervisor");

interface SessionInit {
    chatId: string;
    env: Record<string, string>;
    shellPath: string;
    home: string;
    stateDir: string;
    skillsSource: string | null;
}

function readSessionInit(): Promise<SessionInit> {
    return new Promise((resolve, reject) => {
        const reader = readHandshakeLines(process.stdin as unknown as Duplex, (line) => {
            reader.finish();
            const msg = safeParseJson(line) as Record<string, unknown> | undefined;
            if (!msg || msg.type !== "session_init" || typeof msg.chatId !== "string" || typeof msg.home !== "string") {
                reject(new Error("invalid session_init"));
                return;
            }
            resolve({
                chatId: msg.chatId,
                env: (msg.env && typeof msg.env === "object" ? msg.env : {}) as Record<string, string>,
                shellPath: typeof msg.shellPath === "string" ? msg.shellPath : "/usr/local/bin:/usr/bin:/bin",
                home: msg.home,
                stateDir: typeof msg.stateDir === "string" ? msg.stateDir : join(msg.home, ".sandbox-state"),
                skillsSource: typeof msg.skillsSource === "string" ? msg.skillsSource : null,
            });
        }, () => reject(new Error("session_init too large")), 1024 * 1024);
    });
}

/**
 * host 推送的 skills（只读）→ home/skills 的可写副本（host 版本覆盖同名 skill），
 * node_modules 以符号链接共享只读目录。
 */
function mirrorSkills(source: string, home: string): void {
    const target = join(home, "skills");
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const dest = join(target, name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(join(source, name), dest, { recursive: true, dereference: false });
    }
    const modulesLink = join(target, "node_modules");
    try {
        if (lstatSync(modulesLink)) rmSync(modulesLink, { recursive: true, force: true });
    } catch { /* 不存在 */ }
    if (existsSync(join(source, "node_modules"))) symlinkSync(join(source, "node_modules"), modulesLink);
}

async function main(): Promise<void> {
    const init = await readSessionInit();
    mkdirSync(init.home, { recursive: true });
    if (init.skillsSource && existsSync(init.skillsSource)) {
        try {
            mirrorSkills(init.skillsSource, init.home);
        } catch (err) {
            log.warn("同步 skills 到 home 失败", { error: String(err) });
        }
    }
    const core = new SupervisorCore(process.stdin, process.stdout, {
        chatId: init.chatId,
        home: init.home,
        stateDir: init.stateDir,
        env: init.env,
        shellPath: init.shellPath,
        noNetwork: true,
        readyTimeoutMs: 30_000,
    });
    process.stdin.once("end", () => void core.dispose().finally(() => process.exit(0)));
    process.on("SIGTERM", () => void core.dispose().finally(() => process.exit(0)));
    try {
        await core.start();
    } catch (err) {
        log.error("supervisor 启动失败", { error: String(err) });
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 200);
        return;
    }
    // worker 退出 → SupervisorCore.dispose → stdout end → 进程退出
    process.stdout.once("finish", () => setTimeout(() => process.exit(0), 50));
}

main().catch((err) => {
    process.stderr.write(`supervisor fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
});
