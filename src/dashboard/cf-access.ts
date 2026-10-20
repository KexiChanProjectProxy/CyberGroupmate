/**
 * cf-access.ts — 校验 Cloudflare Access 签发的 JWT（Cf-Access-Jwt-Assertion 头 / CF_Authorization cookie）
 *
 * Dashboard 经 Cloudflare Tunnel 发布并由 Access 保护时，用 Access 登录态代替 dashboard token：
 * 校验 RS256 签名（team 域名的 /cdn-cgi/access/certs）、iss、aud、exp/nbf，以及可选的邮箱白名单。
 * 不信任任何未签名的头（如 Cf-Access-Authenticated-User-Email）。
 */

import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createLogger } from "../core/logger.js";

const log = createLogger("dashboard-cf-access");

export interface CloudflareAccessConfig {
    /** Zero Trust team 域名，例如 yourteam.cloudflareaccess.com */
    teamDomain: string;
    /** Access 应用的 Application Audience (AUD) tag */
    aud: string;
    /** 允许的邮箱（不区分大小写）；为空则接受该应用签发的任意身份 */
    allowedEmails?: string[];
}

export interface AccessIdentity {
    email: string;
}

const CLOCK_SKEW_SEC = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;

function b64urlJson(part: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** 从请求中取 Access JWT：优先 Cf-Access-Jwt-Assertion 头，其次 CF_Authorization cookie */
export function accessTokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
    const header = headers["cf-access-jwt-assertion"];
    if (typeof header === "string" && header) return header;
    const cookie = headers.cookie;
    if (!cookie) return undefined;
    for (const part of cookie.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === "CF_Authorization" && rest.length) return rest.join("=");
    }
    return undefined;
}

export class CloudflareAccessVerifier {
    private readonly issuer: string;
    private readonly allowed: Set<string> | null;
    private keys = new Map<string, KeyObject>();
    private fetchedAt = 0;
    private inflight: Promise<void> | null = null;

    constructor(private readonly cfg: CloudflareAccessConfig, private readonly fetchImpl: typeof fetch = fetch) {
        const domain = cfg.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        this.issuer = `https://${domain}`;
        const emails = (cfg.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
        this.allowed = emails.length ? new Set(emails) : null;
    }

    private async refreshKeys(): Promise<void> {
        if (Date.now() - this.fetchedAt < JWKS_MIN_REFRESH_MS && this.keys.size) return;
        this.inflight ??= (async () => {
            try {
                const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
                if (!res.ok) throw new Error(`certs ${res.status}`);
                const body = await res.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
                const next = new Map<string, KeyObject>();
                for (const jwk of body.keys ?? []) {
                    if (!jwk.kid || jwk.kty !== "RSA") continue;
                    next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
                }
                if (next.size) {
                    this.keys = next;
                    this.fetchedAt = Date.now();
                }
            } catch (err) {
                log.warn("获取 Cloudflare Access 公钥失败", { error: String(err) });
            } finally {
                this.inflight = null;
            }
        })();
        await this.inflight;
    }

    private async keyFor(kid: string): Promise<KeyObject | undefined> {
        if (!this.keys.has(kid) || Date.now() - this.fetchedAt > JWKS_TTL_MS) await this.refreshKeys();
        return this.keys.get(kid);
    }

    /** 校验通过返回身份，否则返回 null（不抛异常） */
    async verify(token: string | undefined): Promise<AccessIdentity | null> {
        if (!token) return null;
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const header = b64urlJson(parts[0]);
        const claims = b64urlJson(parts[1]);
        if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null;

        const key = await this.keyFor(header.kid);
        if (!key) return null;
        const signed = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
        if (!signed) return null;

        const now = Math.floor(Date.now() / 1000);
        if (claims.iss !== this.issuer) return null;
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.includes(this.cfg.aud)) return null;
        if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < now) return null;
        if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SEC > now) return null;

        const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
        if (this.allowed && !this.allowed.has(email)) return null;
        return { email };
    }
}
