/**
 * broker-client.ts — daemon 侧调用 sandbox broker（Cloud Run，IAM 认证）
 */

export type IdTokenProvider = (audience: string) => Promise<string>;

/** GCE 上从 metadata server 获取指定 audience 的 ID token（daemon VM 服务账号需有 run.invoker） */
export function metadataIdTokenProvider(fetchImpl: typeof fetch = fetch): IdTokenProvider {
    const cache = new Map<string, { token: string; expiresAt: number }>();
    return async (audience) => {
        const hit = cache.get(audience);
        if (hit && hit.expiresAt - Date.now() > 120_000) return hit.token;
        const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
        const res = await fetchImpl(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`metadata identity token ${res.status}`);
        const token = (await res.text()).trim();
        let exp = Date.now() + 50 * 60_000;
        try {
            const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
            if (payload.exp) exp = payload.exp * 1000;
        } catch { /* ignore */ }
        cache.set(audience, { token, expiresAt: exp });
        return token;
    };
}

export class BrokerRequestError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = "BrokerRequestError";
    }
}

export interface SandboxVm {
    name: string;
    zone: string;
    region: string;
    machineType: string;
}

export class BrokerClient {
    constructor(
        private readonly baseUrl: string,
        private readonly idToken: IdTokenProvider,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 300_000): Promise<T> {
        const res = await this.fetchImpl(new URL(path, this.baseUrl), {
            method,
            headers: {
                Authorization: `Bearer ${await this.idToken(this.baseUrl.replace(/\/$/, ""))}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch { /* ignore */ }
        if (!res.ok) {
            throw new BrokerRequestError(res.status, String(parsed.error ?? "error"), String(parsed.message ?? text).slice(0, 300));
        }
        return parsed as T;
    }

    create(chatKey: string, region: string, machineType: string): Promise<SandboxVm> {
        return this.call<SandboxVm>("POST", "/v1/sandboxes", { chatKey, region, machineType });
    }

    get(name: string, zone: string): Promise<{ status: string; internalIp: string | null }> {
        return this.call("GET", `/v1/sandboxes/${encodeURIComponent(name)}?zone=${encodeURIComponent(zone)}`, undefined, 30_000);
    }

    async delete(name: string, zone: string): Promise<void> {
        await this.call("DELETE", `/v1/sandboxes/${encodeURIComponent(name)}?zone=${encodeURIComponent(zone)}`, undefined, 60_000);
    }
}
