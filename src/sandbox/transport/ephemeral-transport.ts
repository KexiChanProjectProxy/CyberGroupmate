/**
 * ephemeral-transport.ts — 每个 chat 一台临时 Spot VM
 *
 * 会话开始：按价格从低到高选 region → 请 broker（Cloud Run）创建 C4 Spot VM → 等待 RUNNING 与内网 IP →
 * 等 sandboxd 就绪后经全局 VPC 内网 + mTLS 建立会话。会话结束（空闲回收 / LRU / 错误）即请 broker 删除 VM，
 * home 随 VM 一起丢弃。
 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Readable } from "node:stream";
import { createLogger } from "../../core/logger.js";
import { BrokerClient, BrokerRequestError, type SandboxVm } from "../provisioner/broker-client.js";
import { rankRegions, type SpotPriceBook } from "../provisioner/pricing.js";
import { openRemoteSession, RemoteSessionError, type RemoteSession, type RemoteTransportConfig } from "./remote-transport.js";

const log = createLogger("sandbox-ephemeral");

export interface EphemeralProvisionerConfig {
    broker: BrokerClient;
    prices: SpotPriceBook | null;
    /** 已建 sandbox 子网的候选 region */
    regions: string[];
    machineType: string;
    /** sandboxd 证书中的 SAN（所有临时 VM 共用一张服务端证书） */
    servername: string;
    port: number;
    tls: RemoteTransportConfig["tls"];
    /** 从开始创建到 sandboxd 可连接的上限 */
    vmReadyTimeoutMs: number;
    connectRetryMs?: number;
    /** broker 中区分不同 daemon 的身份（默认主机名）：多个 daemon 共享一个 broker 时，同一 chat 的 VM 互不视为孤儿 */
    owner?: string;
}

export interface EphemeralSession extends RemoteSession {
    vm: SandboxVm;
    release(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function orderRegions(cfg: Pick<EphemeralProvisionerConfig, "prices" | "regions" | "machineType">): Promise<string[]> {
    try {
        const table = await cfg.prices?.get();
        if (table) return rankRegions(table, cfg.machineType, cfg.regions).map((r) => r.region);
    } catch (err) {
        log.warn("价格排序失败，按配置顺序尝试 region", { error: String(err) });
    }
    return [...cfg.regions];
}

export async function openEphemeralSession(
    cfg: EphemeralProvisionerConfig,
    request: { chatId: string; env: Record<string, string>; shellPath: string; skillsHash: string | null },
    deps: { packSkills: () => Readable },
): Promise<EphemeralSession> {
    const chatKey = createHash("sha256").update(`${cfg.owner ?? hostname()}\n${request.chatId}`).digest("hex").slice(0, 32);
    const started = Date.now();
    const regions = await orderRegions(cfg);

    let vm: SandboxVm | null = null;
    let lastError: unknown = null;
    for (const region of regions) {
        try {
            vm = await cfg.broker.create(chatKey, region, cfg.machineType);
            break;
        } catch (err) {
            lastError = err;
            if (err instanceof BrokerRequestError && (err.code === "no_capacity" || err.status === 503)) {
                log.warn("region 无 Spot 容量，尝试下一个", { region, machineType: cfg.machineType });
                continue;
            }
            throw err;
        }
    }
    if (!vm) throw new RemoteSessionError("no_capacity", `所有候选 region 都没有 ${cfg.machineType} Spot 容量: ${String(lastError)}`);
    const created = vm;
    log.info("sandbox VM 已分配", { chatId: request.chatId, name: created.name, zone: created.zone, machineType: created.machineType });

    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        await cfg.broker.delete(created.name, created.zone).catch((err) => {
            log.error("删除 sandbox VM 失败（broker gc / maxRunDuration 会兜底回收）", { name: created.name, error: String(err) });
        });
    };

    try {
        const deadline = started + cfg.vmReadyTimeoutMs;
        let ip: string | null = null;
        while (Date.now() < deadline) {
            const st = await cfg.broker.get(created.name, created.zone);
            if (st.status === "RUNNING" && st.internalIp) {
                ip = st.internalIp;
                break;
            }
            if (["TERMINATED", "STOPPING", "SUSPENDED"].includes(st.status)) {
                throw new RemoteSessionError("vm_terminated", `sandbox VM ${created.name} 状态 ${st.status}（可能被 Spot 回收）`);
            }
            await sleep(cfg.connectRetryMs ?? 3000);
        }
        if (!ip) throw new RemoteSessionError("vm_timeout", `sandbox VM ${created.name} 未在时限内启动`);

        // VM 运行后 sandboxd 仍需数十秒启动（docker + 镜像）：连接失败时重试
        for (;;) {
            try {
                const session = await openRemoteSession(
                    {
                        endpoints: [{ name: created.name, address: `${ip}:${cfg.port}`, servername: cfg.servername }],
                        tls: cfg.tls,
                        connectTimeoutMs: 5_000,
                    },
                    request,
                    deps,
                );
                log.info("sandbox VM 会话就绪", { name: created.name, coldStartMs: Date.now() - started });
                return { ...session, vm: created, release };
            } catch (err) {
                const retryable = err instanceof RemoteSessionError && ["connect_failed", "connect_timeout", "closed", "socket_error"].includes(err.code);
                if (!retryable || Date.now() > deadline) throw err;
                await sleep(cfg.connectRetryMs ?? 3000);
            }
        }
    } catch (err) {
        await release();
        throw err;
    }
}
