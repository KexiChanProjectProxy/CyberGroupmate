/**
 * core/web/fetch.ts — 网页抓取：URL → 正文 markdown / 纯文本
 *
 * - 仅 http/https，拒绝内网地址（每一跳重定向都校验）
 * - 可走 web.proxy 代理
 * - HTML 用 Readability 抽正文，turndown 转 markdown；text/* 与 JSON 原样返回
 * - 响应体按字节上限读取，正文按 maxChars 截断
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { WebConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { assertPublicUrl, getDispatcher, webRequest, WebAccessError } from "./http.js";

const log = createLogger("web-fetch");

const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 200_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface WebFetchOptions {
    format?: "markdown" | "text";
    maxChars?: number;
}

export interface WebFetchResult {
    url: string;
    finalUrl: string;
    status: number;
    title?: string;
    contentType: string;
    content: string;
    truncated: boolean;
}

/** 按字节上限读取响应体 */
async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<{ bytes: Uint8Array; overflow: boolean }> {
    if (!body) return { bytes: new Uint8Array(), overflow: false };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let overflow = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > MAX_BODY_BYTES) {
            chunks.push(value.subarray(0, MAX_BODY_BYTES - total));
            total = MAX_BODY_BYTES;
            overflow = true;
            await reader.cancel().catch(() => undefined);
            break;
        }
        chunks.push(value);
        total += value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
    }
    return { bytes, overflow };
}

/** 从 Content-Type 或 HTML <meta> 推断字符集（导出供测试） */
export function detectCharset(contentType: string, bytes: Uint8Array): string {
    const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
    if (fromHeader) return fromHeader;
    if (/html/i.test(contentType)) {
        const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
        const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
        if (meta) return meta;
    }
    return "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

function absolutize(href: string, base: string): string {
    try {
        return new URL(href, base).href;
    } catch {
        return href;
    }
}

/** HTML → { title, content }（导出供测试） */
export function extractHtml(html: string, baseUrl: string, format: "markdown" | "text"): { title?: string; content: string } {
    const { document } = parseHTML(html);
    const pageTitle = document.querySelector("title")?.textContent?.trim() || undefined;
    let article: { title?: string | null; content?: string | null; textContent?: string | null } | null = null;
    try {
        article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    } catch (err) {
        log.debug("Readability 解析失败，回退到 body", { error: String(err) });
    }
    const title = article?.title?.trim() || pageTitle;

    if (format === "text") {
        const text = article?.textContent ?? parseHTML(html).document.body?.textContent ?? "";
        return { title, content: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
    }

    const fallbackDoc = parseHTML(html).document;
    for (const el of fallbackDoc.querySelectorAll("script,style,noscript,iframe,svg,nav,footer,form")) el.remove();
    const htmlForMd = article?.content || fallbackDoc.body?.innerHTML || "";
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    td.remove(["script", "style", "noscript", "iframe"]);
    td.addRule("absoluteLinks", {
        filter: (node) => node.nodeName === "A" && !!(node as HTMLElement).getAttribute("href"),
        replacement: (content, node) => {
            const href = absolutize((node as HTMLElement).getAttribute("href")!, baseUrl);
            const text = content.trim();
            if (!text) return "";
            if (href.startsWith("javascript:")) return text;
            return `[${text}](${href})`;
        },
    });
    td.addRule("dropImages", { filter: "img", replacement: () => "" });
    const md = td.turndown(htmlForMd).replace(/\n{3,}/g, "\n\n").trim();
    return { title, content: md };
}

export async function webFetch(web: WebConfig | undefined, rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
    const format = options.format === "text" ? "text" : "markdown";
    const configuredMax = web?.fetch?.maxChars ?? DEFAULT_FETCH_MAX_CHARS;
    const maxChars = Math.max(500, Math.min(HARD_MAX_CHARS, Number(options.maxChars) || configuredMax));
    const timeoutMs = web?.fetch?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dispatcher = getDispatcher(web?.proxy, true);
    const headers = {
        "User-Agent": web?.fetch?.userAgent || DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };

    const startTime = Date.now();
    let current = await assertPublicUrl(String(rawUrl ?? "").trim());
    let res: Awaited<ReturnType<typeof webRequest>>;
    for (let hop = 0; ; hop++) {
        res = await webRequest(current.href, { headers, timeoutMs, redirect: "manual" }, dispatcher);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            await res.body?.cancel().catch(() => undefined);
            if (hop >= MAX_REDIRECTS) throw new WebAccessError(`重定向次数超过 ${MAX_REDIRECTS} 次`);
            current = await assertPublicUrl(new URL(location, current).href);
            continue;
        }
        break;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
    const isUnknown = mime === "";
    const isText = mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")
        || mime === "application/xml" || mime.endsWith("+xml") || mime === "application/javascript";
    if (!isHtml && !isText && !isUnknown) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`web.fetch 不支持的内容类型: ${mime || "(unknown)"}（只支持网页和文本）`);
    }

    const { bytes, overflow } = await readLimited(res.body as ReadableStream<Uint8Array> | null);
    const raw = decode(bytes, detectCharset(contentType, bytes));
    let title: string | undefined;
    let content: string;
    if (isHtml || (isUnknown && /<html|<body|<!doctype/i.test(raw.slice(0, 2048)))) {
        ({ title, content } = extractHtml(raw, current.href, format));
    } else {
        content = raw.trim();
    }

    let truncated = overflow;
    if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
    }
    log.info("web.fetch 完成", {
        url: current.href.slice(0, 200),
        status: res.status,
        chars: content.length,
        truncated,
        elapsedMs: Date.now() - startTime,
    });
    return {
        url: String(rawUrl),
        finalUrl: current.href,
        status: res.status,
        ...(title ? { title } : {}),
        contentType: mime || "text/html",
        content,
        truncated,
    };
}
