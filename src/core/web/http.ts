/**
 * core/web/http.ts — web.search / web.fetch 共用的 HTTP 出口
 *
 * - 可选 HTTP(S) 代理（web.proxy），基于 undici ProxyAgent
 * - 直连时在 socket 连接阶段校验解析出的 IP（防 DNS rebinding 打内网）
 * - 代理模式下 DNS 由代理解析，只能在请求前做一次 best-effort 解析校验（见 assertPublicUrl）
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type Response } from "undici";

// ─── 私网 / 保留地址 ───

const blocked = new BlockList();
for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
    ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** 是否为回环 / 私网 / 链路本地 / 保留地址（含 IPv4-mapped IPv6） */
export function isPrivateAddress(address: string): boolean {
    let addr = address.trim().replace(/^\[|\]$/g, "");
    const zone = addr.indexOf("%");
    if (zone >= 0) addr = addr.slice(0, zone);
    const family = isIP(addr);
    if (family === 4) return blocked.check(addr, "ipv4");
    if (family === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
        if (mapped) return blocked.check(mapped[1], "ipv4");
        const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1], 16);
            const lo = parseInt(mappedHex[2], 16);
            return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
        }
        return blocked.check(addr, "ipv6");
    }
    return false;
}

export class WebAccessError extends Error {}

/**
 * 校验 URL：仅 http/https，主机名不能是 localhost / 私网字面量，域名解析结果不能落在私网。
 * 返回规范化后的 URL。
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new WebAccessError(`无效 URL: ${raw.slice(0, 200)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new WebAccessError(`只支持 http / https URL（收到 ${url.protocol}）`);
    }
    if (url.username || url.password) {
        throw new WebAccessError("URL 不能包含用户名或密码");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
        throw new WebAccessError(`[web 安全限制] 不允许访问内网地址: ${host}`);
    }
    if (isIP(host)) {
        if (isPrivateAddress(host)) throw new WebAccessError(`[web 安全限制] 不允许访问内网地址: ${host}`);
        return url;
    }
    let addresses: LookupAddress[];
    try {
        addresses = await dnsLookupAsync(host, { all: true });
    } catch (err) {
        throw new WebAccessError(`域名解析失败: ${host} (${(err as Error).message})`);
    }
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) throw new WebAccessError(`[web 安全限制] ${host} 解析到内网地址 ${bad.address}`);
    return url;
}

/** 直连时的 connect lookup：解析结果落在私网则拒绝连接 */
function guardedLookup(
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
    dnsLookup(hostname, { ...(options as Record<string, unknown>), all: true }, (err, addresses) => {
        if (err) return callback(err, []);
        const list = addresses as LookupAddress[];
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(new WebAccessError(`[web 安全限制] ${hostname} 解析到内网地址 ${bad.address}`), []);
        if ((options as { all?: boolean }).all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
}

// ─── Dispatcher 缓存（按代理地址） ───

const dispatchers = new Map<string, Dispatcher>();

/**
 * 返回出口 dispatcher：有代理用 ProxyAgent，否则用带私网校验的 Agent。
 * guardPrivate=false 用于访问用户自己配置的 API（如自建的 Responses 网关在内网）。
 */
export function getDispatcher(proxy: string | undefined, guardPrivate: boolean): Dispatcher {
    const key = `${proxy ?? ""}|${guardPrivate ? 1 : 0}`;
    let d = dispatchers.get(key);
    if (!d) {
        if (proxy) {
            d = new ProxyAgent({ uri: proxy });
        } else {
            d = guardPrivate ? new Agent({ connect: { lookup: guardedLookup } }) : new Agent();
        }
        dispatchers.set(key, d);
    }
    return d;
}

export interface WebRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    redirect?: "manual" | "follow";
}

/** 走 undici fetch（与指定 dispatcher 配套，避免和 Node 内置 undici 版本错配） */
export function webRequest(url: string, init: WebRequestInit, dispatcher: Dispatcher): Promise<Response> {
    return undiciFetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: init.redirect ?? "follow",
        signal: AbortSignal.timeout(init.timeoutMs),
        dispatcher,
    });
}

/** 测试用：清空 dispatcher 缓存 */
export function resetWebDispatchers(): void {
    for (const d of dispatchers.values()) void d.close().catch(() => undefined);
    dispatchers.clear();
}
