/**
 * broker-server.ts — sandbox VM broker（运行在 Cloud Run）
 *
 * 唯一持有「创建 / 删除 VM」权限的组件；daemon VM 只有调用本服务的 run.invoker 权限。
 * 即使 daemon 被攻陷，也只能在白名单内为 sandbox 开关 VM：
 * - 机型只允许配置的 C4 白名单；region 只允许已建子网的 region；VM 名称由 broker 生成；
 * - 镜像、子网、网络 tag、无服务账号、无外网 IP、Spot、Shielded VM、maxRunDuration 全部固定；
 * - 删除 / 查询只作用于带 cgm-role=sandbox label 且名称以 cgm-sbx- 开头的实例；
 * - 同时存在的 sandbox VM 数量有上限。
 *
 * API（Cloud Run IAM 认证，--no-allow-unauthenticated）：
 *   POST   /v1/sandboxes          {chatKey, region, machineType} → 201 {name, zone, region}
 *   GET    /v1/sandboxes/:name?zone=Z                            → {name, zone, status, internalIp}
 *   DELETE /v1/sandboxes/:name?zone=Z                            → 204
 *   POST   /v1/gc                                                → {deleted: [...]}（Cloud Scheduler 定期调用）
 *   GET    /healthz
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { configureLogger, createLogger } from "../../core/logger.js";
import { GceClient, GceError, isCapacityError, metadataProjectId, metadataTokenProvider, type GceInstance } from "./gce.js";
import { c4MachineShape } from "./pricing.js";

const log = createLogger("sandbox-broker");

export const SANDBOX_NAME_PREFIX = "cgm-sbx-";
export const SANDBOX_LABEL = { key: "cgm-role", value: "sandbox" } as const;

export interface BrokerConfig {
    project: string;
    /** region → 子网名（全局 VPC 中为 sandbox 建的子网） */
    subnets: Record<string, string>;
    /** region → zone 列表（可选；缺省时自动发现） */
    zones?: Record<string, string[]>;
    machineTypes: string[];
    imageFamily: string;
    /** golden image 所在项目（默认同 project） */
    imageProject?: string;
    networkTag: string;
    diskGb: number;
    /** C4 只支持 Hyperdisk */
    diskType: string;
    maxInstances: number;
    /** VM 最长存活时间（到期由 GCE 自动删除，兜底防泄漏） */
    maxRunSeconds: number;
    /** gc：超过该时长的 sandbox VM 一律删除 */
    gcMaxAgeSeconds: number;
}

export function loadBrokerConfigFromEnv(env: NodeJS.ProcessEnv, project: string): BrokerConfig {
    const json = (key: string, fallback: unknown) => (env[key] ? JSON.parse(env[key]!) : fallback);
    const cfg: BrokerConfig = {
        project,
        subnets: json("BROKER_SUBNETS", {}),
        zones: json("BROKER_ZONES", undefined),
        machineTypes: (env.BROKER_MACHINE_TYPES ?? "c4-standard-2,c4-standard-4,c4-standard-8").split(",").map((s) => s.trim()).filter(Boolean),
        imageFamily: env.BROKER_IMAGE_FAMILY ?? "cgm-sandbox-golden",
        imageProject: env.BROKER_IMAGE_PROJECT || undefined,
        networkTag: env.BROKER_NETWORK_TAG ?? "cgm-sandbox",
        diskGb: Number(env.BROKER_DISK_GB ?? 40),
        diskType: env.BROKER_DISK_TYPE ?? "hyperdisk-balanced",
        maxInstances: Number(env.BROKER_MAX_INSTANCES ?? 32),
        maxRunSeconds: Number(env.BROKER_MAX_RUN_SECONDS ?? 24 * 3600),
        gcMaxAgeSeconds: Number(env.BROKER_GC_MAX_AGE_SECONDS ?? 25 * 3600),
    };
    for (const t of cfg.machineTypes) {
        if (!c4MachineShape(t)) throw new Error(`BROKER_MACHINE_TYPES 只能包含 C4 机型: ${t}`);
    }
    if (Object.keys(cfg.subnets).length === 0) throw new Error("BROKER_SUBNETS 不能为空");
    return cfg;
}

const createSchema = z.object({
    chatKey: z.string().regex(/^[a-f0-9]{32}$/),
    region: z.string().regex(/^[a-z]+-[a-z]+\d+$/),
    machineType: z.string().max(32),
}).strict();

const nameSchema = z.string().regex(new RegExp(`^${SANDBOX_NAME_PREFIX}[a-z0-9]{1,40}$`));
const zoneSchema = z.string().regex(/^[a-z]+-[a-z]+\d+-[a-z]$/);

export class BrokerError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

export class SandboxBroker {
    private zoneCache = new Map<string, string[]>();

    constructor(readonly cfg: BrokerConfig, private readonly gce: GceClient) {}

    buildInstanceBody(name: string, zone: string, region: string, machineType: string, chatKey: string): Record<string, unknown> {
        const imageProject = this.cfg.imageProject ?? this.cfg.project;
        return {
            name,
            machineType: `zones/${zone}/machineTypes/${machineType}`,
            labels: {
                [SANDBOX_LABEL.key]: SANDBOX_LABEL.value,
                "cgm-chat": chatKey,
                "cgm-created": String(Math.floor(Date.now() / 1000)),
            },
            tags: { items: [this.cfg.networkTag] },
            disks: [{
                boot: true,
                autoDelete: true,
                initializeParams: {
                    sourceImage: `projects/${imageProject}/global/images/family/${this.cfg.imageFamily}`,
                    diskSizeGb: String(this.cfg.diskGb),
                    diskType: `zones/${zone}/diskTypes/${this.cfg.diskType}`,
                },
            }],
            // 不设置 accessConfigs → 无外网 IP；子网无 NAT / PGA → 无出口
            networkInterfaces: [{
                subnetwork: `projects/${this.cfg.project}/regions/${region}/subnetworks/${this.cfg.subnets[region]}`,
                stackType: "IPV4_ONLY",
                // C4 只支持 gVNIC
                nicType: "GVNIC",
            }],
            // 无服务账号：metadata server 不提供任何 token
            serviceAccounts: [],
            scheduling: {
                provisioningModel: "SPOT",
                instanceTerminationAction: "DELETE",
                automaticRestart: false,
                onHostMaintenance: "TERMINATE",
                maxRunDuration: { seconds: String(this.cfg.maxRunSeconds) },
            },
            shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
            metadata: {
                items: [
                    { key: "enable-oslogin", value: "TRUE" },
                    { key: "block-project-ssh-keys", value: "TRUE" },
                    { key: "serial-port-enable", value: "FALSE" },
                ],
            },
        };
    }

    private async zonesFor(region: string, machineType: string): Promise<string[]> {
        const configured = this.cfg.zones?.[region];
        if (configured?.length) return configured;
        const key = `${region}/${machineType}`;
        const cached = this.zoneCache.get(key);
        if (cached) return cached;
        const zones: string[] = [];
        for (const zone of await this.gce.listZones(region)) {
            if (await this.gce.machineTypeExists(zone, machineType)) zones.push(zone);
        }
        this.zoneCache.set(key, zones);
        return zones;
    }

    async create(input: unknown): Promise<{ name: string; zone: string; region: string; machineType: string }> {
        const parsed = createSchema.safeParse(input);
        if (!parsed.success) throw new BrokerError(400, "bad_request", "invalid request");
        const { chatKey, region, machineType } = parsed.data;
        if (!this.cfg.subnets[region]) throw new BrokerError(400, "region_not_allowed", `region ${region} 未配置子网`);
        if (!this.cfg.machineTypes.includes(machineType)) throw new BrokerError(400, "machine_type_not_allowed", `机型 ${machineType} 不在白名单`);

        const existing = await this.gce.listInstancesByLabel(SANDBOX_LABEL.key, SANDBOX_LABEL.value);
        if (existing.length >= this.cfg.maxInstances) throw new BrokerError(429, "capacity", `sandbox VM 数量已达上限 ${this.cfg.maxInstances}`);

        const zones = await this.zonesFor(region, machineType);
        if (zones.length === 0) throw new BrokerError(503, "no_capacity", `${region} 没有提供 ${machineType} 的 zone`);
        let lastError: unknown = null;
        for (const zone of zones) {
            const name = `${SANDBOX_NAME_PREFIX}${randomBytes(8).toString("hex")}`;
            try {
                await this.gce.insertInstance(zone, this.buildInstanceBody(name, zone, region, machineType, chatKey));
                log.info("sandbox VM 已创建", { name, zone, machineType, chatKey: chatKey.slice(0, 8) });
                return { name, zone, region, machineType };
            } catch (err) {
                lastError = err;
                // 失败的创建可能留下半成品实例
                await this.gce.deleteInstance(zone, name).catch(() => undefined);
                if (!isCapacityError(err)) throw err;
                log.warn("zone 无可用 Spot 容量，尝试下一个", { zone, machineType, error: String(err).slice(0, 200) });
            }
        }
        throw new BrokerError(503, "no_capacity", `${region} 所有 zone 均无 ${machineType} Spot 容量: ${String(lastError).slice(0, 200)}`);
    }

    private async getOwned(nameRaw: unknown, zoneRaw: unknown): Promise<GceInstance> {
        const name = nameSchema.safeParse(nameRaw);
        const zone = zoneSchema.safeParse(zoneRaw);
        if (!name.success || !zone.success) throw new BrokerError(400, "bad_request", "invalid name or zone");
        const inst = await this.gce.getInstance(zone.data, name.data);
        if (!inst) throw new BrokerError(404, "not_found", "instance not found");
        if (inst.labels?.[SANDBOX_LABEL.key] !== SANDBOX_LABEL.value) throw new BrokerError(403, "not_sandbox", "not a sandbox instance");
        return { ...inst, zone: zone.data };
    }

    async get(name: unknown, zone: unknown): Promise<{ name: string; zone: string; status: string; internalIp: string | null }> {
        const inst = await this.getOwned(name, zone);
        return {
            name: inst.name,
            zone: inst.zone,
            status: inst.status,
            internalIp: inst.networkInterfaces?.[0]?.networkIP ?? null,
        };
    }

    async delete(name: unknown, zone: unknown): Promise<void> {
        let inst: GceInstance;
        try {
            inst = await this.getOwned(name, zone);
        } catch (err) {
            if (err instanceof BrokerError && err.code === "not_found") return;
            throw err;
        }
        await this.gce.deleteInstance(inst.zone, inst.name);
        log.info("sandbox VM 已删除", { name: inst.name, zone: inst.zone });
    }

    /** 删除超龄或已终止的 sandbox VM（兜底：daemon 宕机 / 未调用 delete） */
    async gc(now = Date.now()): Promise<string[]> {
        const deleted: string[] = [];
        for (const inst of await this.gce.listInstancesByLabel(SANDBOX_LABEL.key, SANDBOX_LABEL.value)) {
            if (!inst.name.startsWith(SANDBOX_NAME_PREFIX)) continue;
            const created = Number(inst.labels?.["cgm-created"] ?? 0) * 1000 || Date.parse(inst.creationTimestamp ?? "") || 0;
            const tooOld = created > 0 && now - created > this.cfg.gcMaxAgeSeconds * 1000;
            const dead = ["TERMINATED", "STOPPED", "SUSPENDED"].includes(inst.status);
            if (tooOld || dead) {
                await this.gce.deleteInstance(inst.zone, inst.name).catch((err) => log.warn("gc 删除失败", { name: inst.name, error: String(err) }));
                deleted.push(inst.name);
            }
        }
        if (deleted.length) log.info("gc 已删除 sandbox VM", { count: deleted.length });
        return deleted;
    }
}

// ─── HTTP ───

async function readJson(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) throw new BrokerError(413, "too_large", "request too large");
        chunks.push(chunk as Buffer);
    }
    try {
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
        throw new BrokerError(400, "bad_request", "invalid json");
    }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body === undefined ? "" : JSON.stringify(body));
}

export function createBrokerServer(broker: SandboxBroker): Server {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://broker");
        const path = url.pathname;
        try {
            if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
            if (req.method === "POST" && path === "/v1/sandboxes") {
                return send(res, 201, await broker.create(await readJson(req)));
            }
            const m = /^\/v1\/sandboxes\/([^/]+)$/.exec(path);
            if (m && req.method === "GET") return send(res, 200, await broker.get(decodeURIComponent(m[1]), url.searchParams.get("zone")));
            if (m && req.method === "DELETE") {
                await broker.delete(decodeURIComponent(m[1]), url.searchParams.get("zone"));
                return send(res, 204);
            }
            if (req.method === "POST" && path === "/v1/gc") return send(res, 200, { deleted: await broker.gc() });
            send(res, 404, { error: "not_found" });
        } catch (err) {
            if (err instanceof BrokerError) return send(res, err.status, { error: err.code, message: err.message });
            const status = err instanceof GceError && err.status >= 400 && err.status < 600 ? 502 : 500;
            log.error("broker 请求失败", { method: req.method, path, error: String(err).slice(0, 300) });
            send(res, status, { error: "upstream_error", message: String(err instanceof Error ? err.message : err).slice(0, 300) });
        }
    });
}

async function main(): Promise<void> {
    configureLogger({ format: "json", color: false });
    const project = process.env.GOOGLE_CLOUD_PROJECT || await metadataProjectId();
    const cfg = loadBrokerConfigFromEnv(process.env, project);
    const broker = new SandboxBroker(cfg, new GceClient(project, metadataTokenProvider()));
    const port = Number(process.env.PORT ?? 8080);
    createBrokerServer(broker).listen(port, () => log.info("sandbox broker 已启动", { port, regions: Object.keys(cfg.subnets), machineTypes: cfg.machineTypes }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
