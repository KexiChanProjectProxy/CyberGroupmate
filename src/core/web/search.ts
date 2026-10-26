/**
 * core/web/search.ts — 联网搜索：OpenAI Responses API + web_search 内建工具
 *
 * 配置 web.search（api_key / base_url / model），默认模型 gpt-6-luna。
 * 与 grounding-util.ts 的 Grok 路径同一协议，但作为 agent 主动调用的工具：
 * 模型没有真正联网时不丢弃结果，而是返回 searched=false 由 agent 自行判断。
 */

import type { WebConfig } from "../config.js";
import { llmEvents, type LLMCallEvent, type LLMResponseEvent } from "../llm.js";
import { createLogger } from "../logger.js";
import { getDispatcher, webRequest } from "./http.js";

const log = createLogger("web-search");

export const DEFAULT_WEB_SEARCH_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_WEB_SEARCH_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_QUERY_CHARS = 2_000;

export interface WebSearchSource {
    url: string;
    title?: string;
}

export interface WebSearchResult {
    answer: string;
    sources: WebSearchSource[];
    /** 模型是否真的执行了 web_search（false 时 answer 可能只是模型自身知识） */
    searched: boolean;
}

let callCounter = 0;

/** 解析 Responses API 返回体（导出供测试） */
export function parseResponsesSearchOutput(data: unknown): WebSearchResult {
    const output = Array.isArray((data as { output?: unknown })?.output)
        ? (data as { output: Array<Record<string, unknown>> }).output
        : [];
    const searched = output.some((item) => item?.type === "web_search_call");
    const texts: string[] = [];
    const sources: WebSearchSource[] = [];
    const seen = new Set<string>();
    for (const item of output) {
        if (item?.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content as Array<Record<string, unknown>>) {
            if (part?.type !== "output_text") continue;
            if (typeof part.text === "string") texts.push(part.text);
            const annotations = Array.isArray(part.annotations) ? part.annotations as Array<Record<string, unknown>> : [];
            for (const a of annotations) {
                if (a?.type !== "url_citation" || typeof a.url !== "string" || seen.has(a.url)) continue;
                seen.add(a.url);
                sources.push(typeof a.title === "string" && a.title ? { url: a.url, title: a.title } : { url: a.url });
            }
        }
    }
    return { answer: texts.join("\n").trim(), sources, searched };
}

export async function webSearch(web: WebConfig | undefined, query: string): Promise<WebSearchResult> {
    const cfg = web?.search;
    if (!cfg?.apiKey) {
        throw new Error("web.search 未配置：请在 config.yaml 设置 web.search.api_key（以及可选 base_url / model）");
    }
    const q = String(query ?? "").trim();
    if (!q) throw new Error("web.search(query) 需要非空的搜索内容");
    const input = q.slice(0, MAX_QUERY_CHARS);
    const baseUrl = (cfg.baseUrl || DEFAULT_WEB_SEARCH_BASE_URL).replace(/\/+$/, "");
    const model = cfg.model || DEFAULT_WEB_SEARCH_MODEL;
    const callId = `web_search_${Date.now()}_${++callCounter}`;
    const startTime = Date.now();

    if (llmEvents.listenerCount("llm:call") > 0) {
        llmEvents.emit("llm:call", {
            callId,
            caller: "web-search",
            model,
            temperature: 0,
            maxTokens: 0,
            provider: "openai",
            messageSummaries: [{ role: "user", contentPreview: input, imageCount: 0 }],
            timestamp: new Date().toISOString(),
        } satisfies LLMCallEvent);
    }
    const emitResponse = (event: Omit<LLMResponseEvent, "callId" | "caller" | "durationMs" | "timestamp">) => {
        if (llmEvents.listenerCount("llm:response") === 0) return;
        llmEvents.emit("llm:response", {
            callId,
            caller: "web-search",
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            ...event,
        } as LLMResponseEvent);
    };

    let data: unknown;
    try {
        const res = await webRequest(`${baseUrl}/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
                model,
                input: [{ role: "user", content: input }],
                tools: [{ type: "web_search" }],
            }),
            timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }, getDispatcher(web?.proxy, false));
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`web.search API ${res.status}: ${body.slice(0, 300)}`);
        }
        data = await res.json();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitResponse({ contentPreview: "", contentLength: 0, error: message });
        log.warn("web.search 失败", { model, error: message, elapsedMs: Date.now() - startTime });
        throw err instanceof Error ? err : new Error(message);
    }

    const result = parseResponsesSearchOutput(data);
    const usage = (data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    emitResponse({
        contentPreview: result.answer.slice(0, 500),
        contentLength: result.answer.length,
        usage: usage ? {
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        } : undefined,
    });
    log.info("web.search 完成", {
        model,
        searched: result.searched,
        sources: result.sources.length,
        elapsedMs: Date.now() - startTime,
    });
    return result;
}
