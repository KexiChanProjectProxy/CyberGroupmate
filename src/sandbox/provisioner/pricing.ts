/**
 * pricing.ts — C4 Spot VM 价格排序（在可信的 daemon 上运行）
 *
 * GCP 价格每天更新：daemon 每天通过 Cloud Billing Catalog API 拉取一次 Compute Engine SKU，
 * 计算每个候选 region 中指定 C4 机型的 Spot 小时价，从低到高排序；
 * 创建 VM 时按此顺序请求 broker（Cloud Run），遇到 Spot 缺货再顺延。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../../core/logger.js";

const log = createLogger("sandbox-pricing");

/** Compute Engine 在 Billing Catalog 中的 service id */
export const COMPUTE_SERVICE_ID = "6F81-5844-456A";
const DAY_MS = 24 * 3_600_000;

interface CatalogSku {
    description: string;
    category: { resourceGroup: string; usageType: string };
    serviceRegions: string[];
    pricingInfo: Array<{ pricingExpression: { usageUnit: string; tieredRates: Array<{ unitPrice: { units?: string; nanos?: number } }> } }>;
}

export interface RegionUnitPrices {
    /** USD / vCPU·h */
    core: number;
    /** USD / GiB·h */
    ram: number;
}

export interface PriceTable {
    fetchedAt: number;
    /** region → C4 Spot 单价 */
    regions: Record<string, RegionUnitPrices>;
}

export interface MachineShape {
    vcpus: number;
    memoryGiB: number;
}

const C4_MEMORY_PER_VCPU: Record<string, number> = {
    highcpu: 2,
    standard: 3.75,
    highmem: 7.75,
};

/** c4-{standard|highcpu|highmem}-N → vCPU / 内存（GiB）；其它机型返回 null（只允许 C4） */
export function c4MachineShape(machineType: string): MachineShape | null {
    const m = /^c4-(standard|highcpu|highmem)-(\d{1,3})$/.exec(machineType);
    if (!m) return null;
    const vcpus = Number(m[2]);
    if (![2, 4, 8, 16, 24, 32, 48, 96, 144, 192, 288].includes(vcpus)) return null;
    // 2 vCPU 规格的内存不是线性值
    const twoVcpu: Record<string, number> = { standard: 7, highcpu: 4, highmem: 15 };
    return { vcpus, memoryGiB: vcpus === 2 ? twoVcpu[m[1]] : vcpus * C4_MEMORY_PER_VCPU[m[1]] };
}

function unitPrice(sku: CatalogSku): number | null {
    const rates = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates;
    const rate = rates?.[rates.length - 1]?.unitPrice;
    if (!rate) return null;
    return Number(rate.units ?? 0) + (rate.nanos ?? 0) / 1e9;
}

/** 从 Billing Catalog SKU 列表提取每个 region 的 C4 Spot 单价 */
export function parseC4SpotPrices(skus: CatalogSku[], now = Date.now()): PriceTable {
    const regions: Record<string, Partial<RegionUnitPrices>> = {};
    for (const sku of skus) {
        if (sku.category?.usageType !== "Preemptible") continue;
        const d = sku.description ?? "";
        let field: keyof RegionUnitPrices | null = null;
        if (/^Spot Preemptible C4 Instance Core running in /.test(d) && sku.category.resourceGroup === "CPU") field = "core";
        else if (/^Spot Preemptible C4 Instance Ram running in /.test(d) && sku.category.resourceGroup === "RAM") field = "ram";
        if (!field) continue;
        const price = unitPrice(sku);
        if (price == null || price <= 0) continue;
        for (const region of sku.serviceRegions ?? []) {
            (regions[region] ??= {})[field] = price;
        }
    }
    const complete: Record<string, RegionUnitPrices> = {};
    for (const [region, p] of Object.entries(regions)) {
        if (p.core != null && p.ram != null) complete[region] = { core: p.core, ram: p.ram };
    }
    return { fetchedAt: now, regions: complete };
}

export interface RankedRegion {
    region: string;
    hourlyUsd: number;
}

/** 按机型小时价从低到高排序；只保留 candidates（已建子网的 region） */
export function rankRegions(table: PriceTable, machineType: string, candidates: string[]): RankedRegion[] {
    const shape = c4MachineShape(machineType);
    if (!shape) throw new Error(`只支持 C4 机型: ${machineType}`);
    const ranked: RankedRegion[] = [];
    const unpriced: string[] = [];
    for (const region of candidates) {
        const p = table.regions[region];
        if (!p) {
            unpriced.push(region);
            continue;
        }
        ranked.push({ region, hourlyUsd: p.core * shape.vcpus + p.ram * shape.memoryGiB });
    }
    ranked.sort((a, b) => a.hourlyUsd - b.hourlyUsd || a.region.localeCompare(b.region));
    // 无价格数据的 region 排在最后（仍可作为缺货回退）
    return [...ranked, ...unpriced.map((region) => ({ region, hourlyUsd: Number.POSITIVE_INFINITY }))];
}

export async function fetchCatalogSkus(
    getToken: () => Promise<string>,
    opts: { quotaProject?: string; fetchImpl?: typeof fetch } = {},
): Promise<CatalogSku[]> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const skus: CatalogSku[] = [];
    let pageToken = "";
    for (let page = 0; page < 50; page++) {
        const url = new URL(`https://cloudbilling.googleapis.com/v1/services/${COMPUTE_SERVICE_ID}/skus`);
        url.searchParams.set("pageSize", "5000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await fetchImpl(url, {
            headers: {
                Authorization: `Bearer ${await getToken()}`,
                ...(opts.quotaProject ? { "x-goog-user-project": opts.quotaProject } : {}),
            },
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`Billing Catalog API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json() as { skus?: CatalogSku[]; nextPageToken?: string };
        skus.push(...(body.skus ?? []));
        pageToken = body.nextPageToken ?? "";
        if (!pageToken) break;
    }
    return skus;
}

/**
 * 带磁盘缓存的价格表：超过 24h（或无缓存）时刷新；刷新失败时继续使用旧缓存。
 */
export class SpotPriceBook {
    private table: PriceTable | null = null;
    private refreshing: Promise<PriceTable | null> | null = null;

    constructor(
        private readonly cacheFile: string,
        private readonly load: () => Promise<CatalogSku[]>,
        private readonly now: () => number = Date.now,
        private readonly maxAgeMs = DAY_MS,
    ) {
        try {
            if (existsSync(cacheFile)) this.table = JSON.parse(readFileSync(cacheFile, "utf-8")) as PriceTable;
        } catch (err) {
            log.warn("价格缓存损坏，忽略", { cacheFile, error: String(err) });
        }
    }

    async get(): Promise<PriceTable | null> {
        if (this.table && this.now() - this.table.fetchedAt < this.maxAgeMs) return this.table;
        this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async refresh(): Promise<PriceTable | null> {
        try {
            const table = parseC4SpotPrices(await this.load(), this.now());
            if (Object.keys(table.regions).length === 0) throw new Error("价格表为空");
            this.table = table;
            mkdirSync(dirname(this.cacheFile), { recursive: true });
            const tmp = `${this.cacheFile}.tmp`;
            writeFileSync(tmp, JSON.stringify(table));
            renameSync(tmp, this.cacheFile);
            log.info("已刷新 C4 Spot 价格", { regions: Object.keys(table.regions).length });
        } catch (err) {
            log.warn("刷新 C4 Spot 价格失败，沿用旧价格", { error: String(err), hasCache: !!this.table });
        }
        return this.table;
    }
}
