/**
 * gce.ts — 最小化的 Compute Engine REST 客户端（broker 使用，无第三方依赖）
 */

const COMPUTE = "https://compute.googleapis.com/compute/v1";
const METADATA = "http://metadata.google.internal/computeMetadata/v1";

export type TokenProvider = () => Promise<string>;

/** Cloud Run / GCE 上从 metadata server 获取访问令牌（带缓存） */
export function metadataTokenProvider(fetchImpl: typeof fetch = fetch): TokenProvider {
    let cached: { token: string; expiresAt: number } | null = null;
    return async () => {
        if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
        const res = await fetchImpl(`${METADATA}/instance/service-accounts/default/token`, {
            headers: { "Metadata-Flavor": "Google" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`metadata token ${res.status}`);
        const body = await res.json() as { access_token: string; expires_in: number };
        cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        return cached.token;
    };
}

export async function metadataProjectId(fetchImpl: typeof fetch = fetch): Promise<string> {
    const res = await fetchImpl(`${METADATA}/project/project-id`, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`metadata project-id ${res.status}`);
    return (await res.text()).trim();
}

export class GceError extends Error {
    constructor(readonly status: number, readonly reason: string, message: string) {
        super(message);
        this.name = "GceError";
    }
}

/** Spot 缺货 / 配额不足等可以换 zone 重试的错误 */
export function isCapacityError(err: unknown): boolean {
    const text = err instanceof Error ? `${(err as GceError).reason ?? ""} ${err.message}` : String(err);
    return /ZONE_RESOURCE_POOL_EXHAUSTED|RESOURCE_POOL_EXHAUSTED|QUOTA_EXCEEDED|quotaExceeded|UNSUPPORTED_OPERATION|does not have enough resources|not available in zone|stockout|Invalid value for field 'resource.machineType'|machineTypes\/[^ ]+' was not found/i.test(text);
}

export interface GceInstance {
    name: string;
    zone: string;
    status: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
    networkInterfaces?: Array<{ networkIP?: string; accessConfigs?: unknown[] }>;
}

interface GceOperation {
    name: string;
    status: string;
    zone?: string;
    error?: { errors?: Array<{ code: string; message: string }> };
}

export class GceClient {
    constructor(
        readonly project: string,
        private readonly token: TokenProvider,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await this.fetchImpl(`${COMPUTE}/projects/${this.project}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${await this.token()}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            parsed = undefined;
        }
        if (!res.ok) {
            const err = (parsed as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | undefined)?.error;
            throw new GceError(res.status, err?.errors?.[0]?.reason ?? "", err?.message ?? text.slice(0, 300));
        }
        return parsed as T;
    }

    async waitZoneOperation(zone: string, op: GceOperation, timeoutMs = 180_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let current = op;
        while (current.status !== "DONE") {
            if (Date.now() > deadline) throw new GceError(504, "TIMEOUT", `operation ${op.name} timed out`);
            current = await this.request<GceOperation>("POST", `/zones/${zone}/operations/${op.name}/wait`);
        }
        const first = current.error?.errors?.[0];
        if (first) throw new GceError(400, first.code, first.message);
    }

    async insertInstance(zone: string, body: Record<string, unknown>): Promise<void> {
        const op = await this.request<GceOperation>("POST", `/zones/${zone}/instances`, body);
        await this.waitZoneOperation(zone, op);
    }

    async getInstance(zone: string, name: string): Promise<GceInstance | null> {
        try {
            return await this.request<GceInstance>("GET", `/zones/${zone}/instances/${name}`);
        } catch (err) {
            if (err instanceof GceError && err.status === 404) return null;
            throw err;
        }
    }

    async deleteInstance(zone: string, name: string): Promise<void> {
        try {
            await this.request<GceOperation>("DELETE", `/zones/${zone}/instances/${name}`);
        } catch (err) {
            if (err instanceof GceError && err.status === 404) return;
            throw err;
        }
    }

    /** 跨 zone 列出带指定 label 的实例 */
    async listInstancesByLabel(key: string, value: string): Promise<GceInstance[]> {
        const filter = encodeURIComponent(`labels.${key}=${value}`);
        const out: GceInstance[] = [];
        let pageToken = "";
        for (let i = 0; i < 20; i++) {
            const body = await this.request<{ items?: Record<string, { instances?: GceInstance[] }>; nextPageToken?: string }>(
                "GET",
                `/aggregated/instances?filter=${filter}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`,
            );
            for (const scoped of Object.values(body.items ?? {})) out.push(...(scoped.instances ?? []));
            pageToken = body.nextPageToken ?? "";
            if (!pageToken) break;
        }
        return out.map((inst) => ({ ...inst, zone: String(inst.zone ?? "").split("/").pop() ?? "" }));
    }

    async listZones(region: string): Promise<string[]> {
        const body = await this.request<{ items?: Array<{ name: string; status: string; region: string }> }>(
            "GET",
            `/zones?filter=${encodeURIComponent(`region eq .*/regions/${region}$`)}`,
        );
        return (body.items ?? []).filter((z) => z.status === "UP").map((z) => z.name).sort();
    }

    async machineTypeExists(zone: string, machineType: string): Promise<boolean> {
        try {
            await this.request("GET", `/zones/${zone}/machineTypes/${machineType}`);
            return true;
        } catch (err) {
            if (err instanceof GceError && err.status === 404) return false;
            throw err;
        }
    }
}
