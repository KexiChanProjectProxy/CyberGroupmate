/**
 * runtime-config.ts — 把 config.sandbox 转成 Sandbox 的运行时配置（local / remote transport）
 */

import { createLogger } from "../core/logger.js";
import type { SandboxConfig, SandboxProvisionerConfig } from "../core/config.js";
import { BrokerClient, metadataIdTokenProvider } from "./provisioner/broker-client.js";
import { metadataTokenProvider } from "./provisioner/gce.js";
import { fetchCatalogSkus, SpotPriceBook } from "./provisioner/pricing.js";
import { getSizeHint } from "./provisioner/size-hints.js";
import { openEphemeralSession } from "./transport/ephemeral-transport.js";
import type { ProtocolLimits } from "./protocol/limits.js";
import type { SandboxRuntimeConfig } from "./sandbox.js";
import { computeSkillsGeneration, packSkills } from "./skills/skills-sync.js";
import { openRemoteSession } from "./transport/remote-transport.js";

const log = createLogger("sandbox-runtime");

function createEphemeralDeps(prov: SandboxProvisionerConfig): { broker: BrokerClient; prices: SpotPriceBook } {
    const broker = new BrokerClient(prov.brokerUrl, metadataIdTokenProvider());
    const accessToken = metadataTokenProvider();
    const prices = new SpotPriceBook(prov.priceCacheFile, () => fetchCatalogSkus(accessToken, { quotaProject: prov.quotaProject }));
    return { broker, prices };
}

export function buildSandboxRuntime(
    sandbox: SandboxConfig | undefined,
    hostSkillsDir: string,
    /** 测试注入：broker 客户端 / 价格表（默认使用 metadata server 凭据） */
    overrides?: { broker?: BrokerClient; prices?: SpotPriceBook | null },
): SandboxRuntimeConfig {
    let ephemeral: { broker: BrokerClient; prices: SpotPriceBook | null } | null = overrides?.broker
        ? { broker: overrides.broker, prices: overrides.prices ?? null }
        : null;
    const cfg = sandbox ?? { mode: "local", inheritHostEnv: false, skillsSyncBack: false, processExec: false };
    const base: SandboxRuntimeConfig = {
        mode: cfg.mode,
        inheritHostEnv: cfg.inheritHostEnv,
        processExec: cfg.processExec === true,
        ...(cfg.readyTimeoutMs != null ? { readyTimeoutMs: cfg.readyTimeoutMs } : {}),
        ...(cfg.limits ? { limits: cfg.limits as Partial<ProtocolLimits> } : {}),
    };
    if (cfg.mode !== "remote") return base;
    const remote = cfg.remote;
    if (!remote || (!remote.provisioner && remote.endpoints.length === 0)) {
        throw new Error("sandbox.mode=remote 需要配置 sandbox.remote.provisioner 或 sandbox.remote.endpoints");
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
                if (remote.provisioner) {
                    const prov = remote.provisioner;
                    const hinted = getSizeHint(request.chatId);
                    const machineType = prov.sizes[hinted ?? prov.defaultSize] ?? prov.sizes[prov.defaultSize];
                    ephemeral ??= createEphemeralDeps(prov);
                    const session = await openEphemeralSession(
                        {
                            broker: ephemeral.broker,
                            prices: ephemeral.prices,
                            regions: prov.regions,
                            machineType,
                            servername: "cgm-sandbox",
                            port: prov.port,
                            tls: remote.tls ?? null,
                            vmReadyTimeoutMs: prov.vmReadyTimeoutMs,
                        },
                        { chatId: request.chatId, env: request.env, shellPath: request.shellPath, skillsHash },
                        { packSkills: () => packSkills(hostSkillsDir) },
                    );
                    return { socket: session.socket, home: session.home, release: session.release };
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
