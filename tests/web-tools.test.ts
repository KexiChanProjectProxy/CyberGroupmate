import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { parse as parseYAML } from "yaml";
import { clearConfigCache, loadConfig, saveConfig } from "../src/core/config.js";
import { assertPublicUrl, isPrivateAddress, resetWebDispatchers } from "../src/core/web/http.js";
import { detectCharset, extractHtml } from "../src/core/web/fetch.js";
import { parseResponsesSearchOutput, webSearch } from "../src/core/web/search.js";

const dir = mkdtempSync(join(tmpdir(), "cgm-web-tools-"));
const LLM = "llm_profiles:\n  default:\n    provider: openai\n    api_key: k\n    model: m\n";

after(() => {
    rmSync(dir, { recursive: true, force: true });
    resetWebDispatchers();
});
afterEach(() => clearConfigCache());

function load(yaml: string) {
    const path = join(dir, `c-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(path, LLM + yaml);
    return { path, cfg: loadConfig(path, true) };
}

describe("private address detection", () => {
    it("blocks loopback, private, link-local and IPv4-mapped IPv6", () => {
        for (const a of ["127.0.0.1", "10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1",
            "0.0.0.0", "::1", "::", "fd00::1", "fe80::1%eth0", "::ffff:127.0.0.1", "::ffff:a00:1", "[::1]"]) {
            assert.equal(isPrivateAddress(a), true, a);
        }
    });

    it("allows public addresses and leaves hostnames to DNS checks", () => {
        for (const a of ["93.184.215.14", "172.32.0.1", "8.8.8.8", "2606:4700::1111", "example.com"]) {
            assert.equal(isPrivateAddress(a), false, a);
        }
    });

    it("rejects non-http schemes, credentials and internal hostnames before any request", async () => {
        for (const u of ["file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/", "http://localhost:8080/",
            "http://metadata.google.internal/", "http://printer.local/", "http://[::1]/", "http://2130706433/", "not a url"]) {
            await assert.rejects(assertPublicUrl(u), undefined, u);
        }
    });
});

describe("web.search response parsing", () => {
    it("joins output_text, dedupes citations and reports whether a search ran", () => {
        const parsed = parseResponsesSearchOutput({
            output: [
                { type: "web_search_call", status: "completed" },
                {
                    type: "message",
                    content: [
                        { type: "output_text", text: "A", annotations: [
                            { type: "url_citation", url: "https://a.example/", title: "A" },
                            { type: "url_citation", url: "https://a.example/" },
                            { type: "file_citation", file_id: "x" },
                        ] },
                        { type: "output_text", text: "B", annotations: [{ type: "url_citation", url: "https://b.example/", title: "" }] },
                    ],
                },
            ],
        });
        assert.deepEqual(parsed, {
            answer: "A\nB",
            sources: [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/" }],
            searched: true,
        });
    });

    it("tolerates empty or malformed bodies", () => {
        assert.deepEqual(parseResponsesSearchOutput({}), { answer: "", sources: [], searched: false });
        assert.deepEqual(parseResponsesSearchOutput(null), { answer: "", sources: [], searched: false });
        assert.deepEqual(parseResponsesSearchOutput({ output: [{ type: "message", content: "oops" }] }), { answer: "", sources: [], searched: false });
    });

    it("sends model + web_search tool to the configured base URL and surfaces API errors", async () => {
        const bodies: unknown[] = [];
        let status = 200;
        const server: Server = createServer((req, res) => {
            let raw = "";
            req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
                res.writeHead(status, { "content-type": "application/json" });
                res.end(status === 200
                    ? JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })
                    : JSON.stringify({ error: "bad key" }));
            });
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
        try {
            const result = await webSearch({ search: { apiKey: "sk-test", baseUrl, model: "gpt-6-luna" } }, "  query  ");
            assert.deepEqual(result, { answer: "hi", sources: [], searched: false });
            assert.deepEqual(bodies[0], {
                url: "/v1/responses",
                auth: "Bearer sk-test",
                body: { model: "gpt-6-luna", input: [{ role: "user", content: "query" }], tools: [{ type: "web_search" }] },
            });
            status = 401;
            await assert.rejects(webSearch({ search: { apiKey: "sk-test", baseUrl } }, "q"), /web\.search API 401/);
        } finally {
            server.close();
        }
    });

    it("refuses to run without an api key or query", async () => {
        await assert.rejects(webSearch(undefined, "q"), /未配置/);
        await assert.rejects(webSearch({ search: { apiKey: "k" } }, "   "), /非空/);
    });
});

describe("web.fetch content extraction", () => {
    it("reads charset from header first, then from <meta>", () => {
        const html = new TextEncoder().encode('<html><head><meta charset="gbk"></head></html>');
        assert.equal(detectCharset("text/html; charset=Shift_JIS", html), "Shift_JIS");
        assert.equal(detectCharset("text/html", html), "gbk");
        assert.equal(detectCharset("application/json", html), "utf-8");
    });

    it("makes links absolute, drops scripts/images and javascript: hrefs", () => {
        const { title, content } = extractHtml(
            "<html><head><title>T</title><script>alert(1)</script></head><body><p>Read <a href=\"/docs/x\">the docs</a>" +
            " or <a href=\"javascript:void(0)\">this</a>.</p><img src=\"/a.png\" alt=\"pic\"></body></html>",
            "https://example.com/base/page",
            "markdown",
        );
        assert.equal(title, "T");
        assert.match(content, /\[the docs\]\(https:\/\/example\.com\/docs\/x\)/);
        assert.doesNotMatch(content, /alert|javascript:|a\.png/);
    });
});

describe("config: web", () => {
    it("parses web config and drops a search block without api_key", () => {
        const { cfg } = load([
            "web:",
            "  proxy: http://127.0.0.1:7890",
            "  search:",
            "    model: gpt-6-luna",
            "  fetch:",
            "    max_chars: 5000",
        ].join("\n") + "\n");
        assert.deepEqual(cfg.web, { proxy: "http://127.0.0.1:7890", fetch: { maxChars: 5000 } });
    });

    it("round-trips web through saveConfig", () => {
        const { path, cfg } = load([
            "web:",
            "  proxy: http://proxy:3128",
            "  search:",
            "    api_key: sk",
            "    base_url: https://gw.example/v1",
            "    model: gpt-6-luna",
        ].join("\n") + "\n");
        assert.equal(saveConfig(cfg, path).ok, true);
        const saved = parseYAML(readFileSync(path, "utf-8")) as Record<string, any>;
        assert.deepEqual(saved.web, {
            proxy: "http://proxy:3128",
            search: { api_key: "sk", base_url: "https://gw.example/v1", model: "gpt-6-luna" },
        });
    });
});
