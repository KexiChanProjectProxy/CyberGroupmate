/**
 * runtime-config.ts — 把 config.sandbox 转成 Sandbox 的运行时配置（local / remote transport）
 */

import { createLogger } from "../core/logger.js";
import type { SandboxConfig } from "../core/config.js";
import type { ProtocolLimits } from "./protocol/limits.js";
import type { SandboxRuntimeConfig } from "./sandbox.js";
import { computeSkillsGeneration, packSkills } from "./skills/skills-sync.js";
import { openRemoteSession } from "./transport/remote-transport.js";

const log = createLogger("sandbox-runtime");

export function buildSandboxRuntime(sandbox: SandboxConfig | undefined, hostSkillsDir: string): SandboxRuntimeConfig {
    const cfg = sandbox ?? { mode: "local", inheritHostEnv: false, skillsSyncBack: false };
    const base: SandboxRuntimeConfig = {
        mode: cfg.mode,
        inheritHostEnv: cfg.inheritHostEnv,
        ...(cfg.readyTimeoutMs != null ? { readyTimeoutMs: cfg.readyTimeoutMs } : {}),
        ...(cfg.limits ? { limits: cfg.limits as Partial<ProtocolLimits> } : {}),
    };
    if (cfg.mode !== "remote") return base;
    const remote = cfg.remote;
    if (!remote || remote.endpoints.length === 0) {
        throw new Error("sandbox.mode=remote 需要配置 sandbox.remote.endpoints 与 sandbox.remote.tls");
    }
    if (cfg.inheritHostEnv) {
        log.warn("sandbox.inherit_host_env 在 remote 模式下被忽略（宿主环境变量永远不会发送到 sandbox VM）");
    }
    return {
        ...base,
        inheritHostEnv: false,
        skillsSyncBack: cfg.skillsSyncBack,
        remote: {
            pingIntervalMs: remote.pingIntervalMs,
            openSession: async (request) => {
                let skillsHash: string | null = null;
                try {
                    const generation = computeSkillsGeneration(hostSkillsDir);
                    skillsHash = generation.files > 0 ? generation.hash : null;
                } catch (err) {
                    log.warn("计算 skills generation 失败，本次会话不携带 skills", { error: String(err) });
                }
                const session = await openRemoteSession(
                    {
                        endpoints: remote.endpoints,
                        tls: remote.tls,
                        connectTimeoutMs: remote.connectTimeoutMs,
                    },
                    { chatId: request.chatId, env: request.env, shellPath: request.shellPath, skillsHash },
                    { packSkills: () => packSkills(hostSkillsDir) },
                );
                return { socket: session.socket, home: session.home };
            },
        },
    };
}
