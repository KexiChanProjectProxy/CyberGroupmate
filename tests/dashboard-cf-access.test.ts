/**
 * dashboard-cf-access.test.ts — Cloudflare Access JWT 校验（签名 / iss / aud / 过期 / 邮箱白名单）与配置往返
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { parse as parseYAML } from "yaml";
import { CloudflareAccessVerifier, accessTokenFromHeaders } from "../src/dashboard/cf-access.js";
import { clearConfigCache, loadConfig, saveConfig, validateConfig } from "../src/core/config.js";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-123";

function keypair() {
    return generateKeyPairSync("rsa", { modulusLength: 2048 });
}
const good = keypair();
const other = keypair();

function jwks(kid: string, pub: KeyObject) {
    return { keys: [{ ...pub.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
}

function fakeFetch(body: unknown): typeof fetch & { calls: number } {
    const f = (async () => {
        f.calls++;
        return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch & { calls: number };
    f.calls = 0;
    return f;
}

function jwt(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
        iss: `https://${TEAM}`, aud: [AUD], email: "Owner@Example.com", iat: now, nbf: now, exp: now + 3600, ...claims,
    })).toString("base64url");
    const sig = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), opts.key ?? good.privateKey).toString("base64url");
    return `${header}.${body}.${sig}`;
}

describe("CloudflareAccessVerifier", () => {
    const verifier = () => new CloudflareAccessVerifier(
        { teamDomain: TEAM, aud: AUD, allowedEmails: ["owner@example.com"] },
        fakeFetch(jwks("k1", good.publicKey)),
    );

    it("accepts a valid token and normalises the email", async () => {
        assert.deepEqual(await verifier().verify(jwt({})), { email: "owner@example.com" });
    });

    it("rejects wrong signature, issuer, audience, expiry, nbf, email, alg and malformed tokens", async () => {
        const v = verifier();
        const now = Math.floor(Date.now() / 1000);
        const cases: Array<[string, string | undefined]> = [
            ["other key", jwt({}, { key: other.privateKey })],
            ["issuer", jwt({ iss: "https://evil.cloudflareaccess.com" })],
            ["audience", jwt({ aud: ["other-aud"] })],
            ["expired", jwt({ exp: now - 3600 })],
            ["not yet valid", jwt({ nbf: now + 3600 })],
            ["email", jwt({ email: "someone@else.com" })],
            ["no email (service token)", jwt({ email: undefined })],
            ["alg none", jwt({}, { alg: "none" })],
            ["unknown kid", jwt({}, { kid: "k2" })],
            ["malformed", "a.b"],
            ["empty", undefined],
        ];
        for (const [name, token] of cases) assert.equal(await v.verify(token), null, name);
    });

    it("caches the key set and accepts any email when no allowlist is configured", async () => {
        const f = fakeFetch(jwks("k1", good.publicKey));
        const v = new CloudflareAccessVerifier({ teamDomain: `https://${TEAM}/`, aud: AUD }, f);
        assert.ok(await v.verify(jwt({ email: "a@b.c" })));
        assert.ok(await v.verify(jwt({})));
        assert.equal(f.calls, 1);
    });

    it("reads the token from the header or the CF_Authorization cookie", () => {
        assert.equal(accessTokenFromHeaders({ "cf-access-jwt-assertion": "h.h.h" }), "h.h.h");
        assert.equal(accessTokenFromHeaders({ cookie: "a=1; CF_Authorization=c.c.c; b=2" }), "c.c.c");
        assert.equal(accessTokenFromHeaders({ cookie: "a=1" }), undefined);
        assert.equal(accessTokenFromHeaders({}), undefined);
    });
});

describe("dashboard.cloudflare_access config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgm-cfa-config-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    afterEach(() => clearConfigCache());
    const LLM = "llm_profiles:\n  default:\n    provider: openai\n    api_key: k\n    model: m\n";

    it("parses, validates and round-trips through saveConfig", () => {
        const path = join(dir, "c.yaml");
        writeFileSync(path, `${LLM}dashboard:\n  token: t\n  cloudflare_access:\n    team_domain: ${TEAM}\n    aud: ${AUD}\n    allowed_emails: [owner@example.com]\n`);
        const cfg = loadConfig(path, true);
        assert.deepEqual(cfg.dashboard?.cloudflareAccess, { teamDomain: TEAM, aud: AUD, allowedEmails: ["owner@example.com"] });
        assert.equal(validateConfig(cfg).valid, true);
        assert.equal(saveConfig(cfg, path).ok, true);
        const saved = parseYAML(readFileSync(path, "utf-8"));
        assert.deepEqual(saved.dashboard.cloudflare_access, { team_domain: TEAM, aud: AUD, allowed_emails: ["owner@example.com"] });
    });

    it("treats an empty block (as sent by the dashboard UI) as disabled, and rejects half-filled ones", () => {
        const base = { llmProfiles: { default: { provider: "openai", apiKey: "k", model: "m" } } };
        const empty = { ...base, dashboard: { cloudflareAccess: { teamDomain: "", aud: "", allowedEmails: [] } } };
        assert.deepEqual(validateConfig(empty).errors.filter((e) => e.includes("cloudflare_access")), []);
        const half = { ...base, dashboard: { cloudflareAccess: { teamDomain: TEAM, aud: "" } } };
        assert.ok(validateConfig(half).errors.some((e) => e.includes("cloudflare_access")));
    });
});
