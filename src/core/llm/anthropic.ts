/**
 * llm/anthropic.ts — Anthropic Claude API 调用
 */

import type { LLMConfig } from "../config.js";
import { reasoningOriginKey } from "./reasoning-origin.js";
import type { ChatMessage, LLMResponse } from "./types.js";

/**
 * 调用 Anthropic Claude API
 */
export async function callAnthropic(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    thinkingLevel?: string,
    prefill?: string,
    stop?: string[],
    signal?: AbortSignal,
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;
    const originKey = reasoningOriginKey(config, model);

    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        ...(config.customHeaders ?? {}),
    };

    const thinkingEnabled = Boolean(thinkingLevel && thinkingLevel !== "none");
    const streaming = config.chatRequestMode === "stream";

    // 组装 API 消息列表。includeReasoning=false 时不回传 thinking block（签名失效时的重试）
    const buildMessages = (includeReasoning: boolean) => nonSystemMsgs.map((m) => {
        const hasCacheBreakpoint = !!m.cacheBreakpoint;

        // 有 imageParts 时组装为 Anthropic 多模态格式
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const parts: Array<Record<string, unknown>> = [
                { type: "text", text: m.content },
            ];
            for (const img of m.imageParts) {
                // Anthropic 需要 base64 source 格式
                const dataMatch = img.url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataMatch) {
                    parts.push({
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: dataMatch[1],
                            data: dataMatch[2],
                        },
                    });
                } else {
                    // URL 格式（Anthropic 也支持）
                    parts.push({
                        type: "image",
                        source: {
                            type: "url",
                            url: img.url,
                        },
                    });
                }
            }
            if (hasCacheBreakpoint && parts.length > 0) {
                const lastPart = parts[parts.length - 1] as Record<string, unknown>;
                lastPart.cache_control = { type: "ephemeral" };
            }
            return { role: m.role, content: parts };
        }

        // 只回传本 profile 自己签发的 thinking block：signature 只对签发它的上游有效。
        if (includeReasoning && m.role === "assistant" && m.reasoning?.provider === "anthropic" && m.reasoning.originKey === originKey) {
            const parts: Array<Record<string, unknown>> = [
                ...m.reasoning.blocks.map((block) => ({ ...block })),
                { type: "text", text: m.content },
            ];
            if (hasCacheBreakpoint) {
                parts[parts.length - 1].cache_control = { type: "ephemeral" };
            }
            return { role: m.role, content: parts };
        }

        if (hasCacheBreakpoint) {
            return {
                role: m.role,
                content: [{
                    type: "text",
                    text: m.content,
                    cache_control: { type: "ephemeral" },
                }],
            };
        }

        return { role: m.role, content: m.content };
    });

    const apiMessages = buildMessages(true);
    // Prefill: 追加 assistant 消息作为生成起点
    // Anthropic 不允许 assistant prefill 与 extended/adaptive thinking 同时使用。
    // callLLM 外层仍会把 prefill 拼回最终 content，保持调用方返回值语义不变。
    const withPrefill = (list: Array<{ role: string; content: unknown }>) =>
        prefill && !thinkingEnabled ? [...list, { role: "assistant", content: prefill }] : list;

    const body: Record<string, unknown> = {
        model,
        messages: withPrefill(apiMessages),
        ...(config.omit_temperature ? {} : { temperature }),
        max_tokens: maxTokens,
        ...(thinkingEnabled ? {
            thinking: { type: "adaptive" },
            output_config: { effort: toAnthropicEffort(thinkingLevel) },
        } : {}),
        // Stop sequences（Anthropic 使用 stop_sequences 字段）
        ...(stop && stop.length > 0 ? { stop_sequences: stop } : {}),
        // Extra body（用户自定义额外字段）
        ...(config.extraBody ?? {}),
        // 请求模式决定解析方式，不能被 extra_body.stream 覆盖。
        stream: streaming,
    };

    if (systemMsg) {
        body.system = [{
            type: "text",
            text: systemMsg.content,
            cache_control: { type: "ephemeral" },
        }];
    }

    const post = (payload: Record<string, unknown>) => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
    });
    let response = await post(body);

    // 回传的 thinking block 签名失效（如上下文被压缩 / 改写后前缀不再一致）：去掉 thinking block 重试一次
    if (response.status === 400 && nonSystemMsgs.some((m) => m.reasoning?.provider === "anthropic")) {
        const errorBody = await response.text().catch(() => "");
        if (/signature/i.test(errorBody) && /thinking/i.test(errorBody)) {
            response = await post({ ...body, messages: withPrefill(buildMessages(false)) });
        } else {
            throw new Error(`Anthropic API error ${response.status}: ${response.statusText} — ${errorBody}`);
        }
    }

    if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new Error(
            `Anthropic API error ${response.status}: ${response.statusText} — ${responseBody}`
        );
    }

    const data = streaming
        ? await collectAnthropicStream(response, model)
        : (await response.json()) as AnthropicMessage;

    const text = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");

    const thinkingBlocks = data.content
        ?.filter((c) => c.type === "thinking" || c.type === "redacted_thinking")
        .map((c) => ({ ...c }));

    if (!text) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content: text,
        reasoning: thinkingBlocks?.length
            ? {
                provider: "anthropic",
                blocks: thinkingBlocks,
                originKey,
                tokenCount: data.usage?.output_tokens_details?.thinking_tokens,
            }
            : undefined,
        usage: data.usage
            ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens:
                    (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
                cachedTokens: data.usage.cache_read_input_tokens,
                cacheCreationTokens: data.usage.cache_creation_input_tokens,
                reasoningTokens: data.usage.output_tokens_details?.thinking_tokens,
            }
            : undefined,
    };
}

type ContentBlock = Record<string, unknown> & { type: string; text?: string };

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: {
        thinking_tokens?: number;
    };
}

interface AnthropicMessage {
    content: ContentBlock[];
    usage?: AnthropicUsage;
}

/**
 * 解析 Messages API 的 SSE 流（stream: true），聚合为与非流式响应相同的结构。
 * 事件：message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop / ping / error。
 */
export async function collectAnthropicStream(response: Response, model: string): Promise<AnthropicMessage> {
    if (!response.body) throw new Error(`Anthropic stream returned no body from model ${model}`);
    const blocks: ContentBlock[] = [];
    let usage: AnthropicUsage | undefined;
    let finished = false;

    const handle = (event: Record<string, any>) => {
        switch (event.type) {
            case "message_start":
                usage = { ...(event.message?.usage ?? {}) };
                break;
            case "content_block_start":
                blocks[event.index] = { ...event.content_block };
                break;
            case "content_block_delta": {
                const block = blocks[event.index];
                const delta = event.delta ?? {};
                if (!block) break;
                if (delta.type === "text_delta") block.text = (block.text ?? "") + (delta.text ?? "");
                else if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + (delta.thinking ?? "");
                else if (delta.type === "signature_delta") block.signature = String(block.signature ?? "") + (delta.signature ?? "");
                else if (delta.type === "input_json_delta") block.partial_json = String(block.partial_json ?? "") + (delta.partial_json ?? "");
                break;
            }
            case "message_delta":
                // message_delta.usage 是累计值，覆盖 message_start 中的同名字段
                if (event.usage) usage = { ...(usage ?? {}), ...event.usage };
                break;
            case "message_stop":
                finished = true;
                break;
            case "error":
                throw new Error(`Anthropic stream error from model ${model}: ${event.error?.type ?? ""} ${event.error?.message ?? JSON.stringify(event)}`);
        }
    };

    const decoder = new TextDecoder();
    let buffer = "";
    const flushEvent = (raw: string) => {
        const data = raw.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (!data) return;
        let parsed: Record<string, any>;
        try {
            parsed = JSON.parse(data);
        } catch {
            throw new Error(`Anthropic stream returned invalid JSON from model ${model}: ${data.slice(0, 200)}`);
        }
        handle(parsed);
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
            flushEvent(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flushEvent(buffer);
    if (!finished) throw new Error(`Anthropic stream ended before completion from model ${model}`);

    return { content: blocks.filter(Boolean), usage };
}

function toAnthropicEffort(value?: string): "low" | "medium" | "high" | "max" {
    if (value === "low" || value === "high" || value === "max") return value;
    if (value === "xhigh") return "max";
    return "medium";
}
