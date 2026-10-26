/**
 * llm/ai-sdk.ts — 经 AI SDK（https://ai-sdk.dev）调用 Anthropic Messages / OpenAI Responses / OpenAI 兼容 Chat Completions
 *
 * 协议细节（请求组装、SSE 解析、reasoning 回传格式）交给 @ai-sdk/*；本文件只负责：
 * - ChatMessage ⇄ ModelMessage 转换，LLMReasoning 持久化格式与 SDK reasoning part 互转（格式不变，历史数据可续用）
 * - profile 选项：extra_body 合并进请求体、自定义头（含 client identity 的 User-Agent 原样发送）
 * - 错误文本保持 `<Provider> API error <status>: … — <body>`，llm.ts 的重试 / fallback 分类按文本匹配
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
    APICallError,
    InvalidResponseDataError,
    StreamProviderError,
    generateText,
    streamText,
    type Instructions,
    type LanguageModel,
    type LanguageModelUsage,
    type ModelMessage,
    type ProviderMetadata,
} from "ai";
import type { LLMConfig } from "../config.js";
import { createLogger } from "../logger.js";
import type { ChatMessage, LLMResponse } from "./types.js";

const log = createLogger("ai-sdk");

// SDK 的调用告警（如某参数被 provider 忽略）默认直接写 console；改走统一日志
globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    log.debug("AI SDK warnings", { provider, model, warnings: JSON.stringify(warnings).slice(0, 500) });
};

type Protocol = "anthropic" | "responses" | "chat";

const PROTOCOL_LABEL: Record<Protocol, string> = {
    anthropic: "Anthropic",
    responses: "OpenAI Responses",
    chat: "OpenAI",
};

export interface SdkRequest {
    protocol: Protocol;
    config: LLMConfig;
    model: string;
    /** v7 不允许 messages 中出现 system 消息，统一经 instructions 传入（调用方的 system 消息都在开头） */
    instructions?: Instructions;
    messages: ModelMessage[];
    temperature?: number;
    maxOutputTokens?: number;
    /** Responses API 没有 stop 参数，只在客户端截断；其余协议照常发送，并同样在客户端截断（部分网关会忽略 stop） */
    stopSequences?: string[];
    providerOptions?: Record<string, Record<string, unknown>>;
    signal?: AbortSignal;
}

export interface SdkResult {
    text: string;
    reasoning: Array<{ text: string; providerMetadata?: ProviderMetadata }>;
    usage: LanguageModelUsage;
    finishReason: string;
    rawFinishReason?: string;
    providerMetadata?: ProviderMetadata;
}

/**
 * profile 对请求的改写：extra_body 展开进 JSON 请求体（请求模式决定解析方式，stream 不允许被覆盖；
 * stream_options 与 SDK 的 include_usage 合并），User-Agent 用 profile 配置的原值替换 SDK 追加的后缀。
 * SSE 响应体读取出错时按正常结束处理：部分网关在发出完成事件后直接断开连接，
 * 是否真正完成由 runSdkRequest 按完成事件判断。
 */
function profileFetch(config: LLMConfig, protocol: Protocol): typeof fetch {
    const userAgent = Object.entries(config.customHeaders ?? {}).find(([key]) => key.toLowerCase() === "user-agent")?.[1];
    const extraBody = config.extraBody;
    return async (input, init) => {
        let next = init;
        if (extraBody && typeof init?.body === "string") {
            const body = JSON.parse(init.body) as Record<string, unknown>;
            const merged: Record<string, unknown> = { ...body, ...extraBody };
            if ("stream" in body) merged.stream = body.stream;
            if (body.stream_options) {
                merged.stream_options = {
                    ...(body.stream_options as Record<string, unknown>),
                    ...(extraBody.stream_options as Record<string, unknown> ?? {}),
                };
            }
            next = { ...init, body: JSON.stringify(merged) };
        }
        if (userAgent) {
            const headers = new Headers(next?.headers);
            headers.set("user-agent", userAgent);
            next = { ...next, headers };
        }
        const response = await fetch(input, next);
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
        const body = endOnReadError(response.body);
        return new Response(protocol === "chat" ? body.pipeThrough(onlyFirstChoice()) : body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

function endOnReadError(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch {
                controller.close();
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/**
 * Chat Completions SSE：只保留 choices[].index === 0（我们从不请求 n>1；个别网关仍会夹带其他 choice，
 * SDK 不区分 index 会把它们拼进正文）。
 */
function onlyFirstChoice(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const rewrite = (event: string): string => event.replace(/^data: ?(.*)$/m, (line, data: string) => {
        if (!data.startsWith("{")) return line;
        try {
            const parsed = JSON.parse(data) as { choices?: Array<{ index?: number }> };
            if (!Array.isArray(parsed.choices)) return line;
            const choices = parsed.choices.filter((choice) => (choice.index ?? 0) === 0);
            if (choices.length === parsed.choices.length) return line;
            // 只有非零 choice 且没有 usage 的帧整帧丢弃
            if (choices.length === 0 && !("usage" in parsed && parsed.usage)) return "";
            return `data: ${JSON.stringify({ ...parsed, choices })}`;
        } catch {
            return line;
        }
    });
    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const event = rewrite(buffer.slice(0, match.index));
                if (event) controller.enqueue(encoder.encode(event + match[0]));
                buffer = buffer.slice(match.index + match[0].length);
            }
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
        },
    });
}

function languageModel(protocol: Protocol, config: LLMConfig, model: string): LanguageModel {
    const settings = {
        baseURL: config.baseUrl.replace(/\/$/, ""),
        apiKey: config.apiKey,
        headers: config.customHeaders,
        fetch: profileFetch(config, protocol),
    };
    switch (protocol) {
        case "anthropic":
            return createAnthropic(settings).messages(model);
        case "responses":
            return createOpenAI(settings).responses(model);
        case "chat":
            return createOpenAICompatible({ ...settings, name: "openaiCompatible", includeUsage: true }).chatModel(model);
    }
}

/** SDK 错误 → 与旧实现一致的错误文本（状态码 / 上游 body / 错误类型必须出现在 message 中） */
function toLLMError(protocol: Protocol, error: unknown, model: string): unknown {
    const label = PROTOCOL_LABEL[protocol];
    // 流已开始后上游下发的 error 事件（如 overloaded_error）
    if (StreamProviderError.isInstance(error)) {
        const status = error.statusCode != null ? ` (${error.statusCode})` : "";
        return new Error(`${label} stream error from model ${model}: ${error.type ?? ""} ${error.message}${status}`, { cause: error });
    }
    if (!APICallError.isInstance(error)) return error;
    if (error.statusCode != null) {
        return new Error(`${label} API error ${error.statusCode}: ${error.message} — ${error.responseBody ?? ""}`, { cause: error });
    }
    // 连接失败：保留底层原因（fetch failed / ECONNRESET / ETIMEDOUT …）
    const causes: string[] = [];
    for (let cause: unknown = error.cause; cause instanceof Error && causes.length < 4; cause = cause.cause) {
        causes.push(`${cause.message}${(cause as NodeJS.ErrnoException).code ? ` (${(cause as NodeJS.ErrnoException).code})` : ""}`);
    }
    return new Error(`${label} API request failed: ${[error.message, ...causes].join(" — ")}`, { cause: error });
}

export class SdkHttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly responseBody: string) {
        super(message);
    }
}

/** 发起一次调用；stream 模式在后台聚合完整输出，中途取消 / 出错 / 未正常结束一律抛错，不返回半截内容 */
export async function runSdkRequest(request: SdkRequest, streaming: boolean): Promise<SdkResult> {
    const options = {
        model: languageModel(request.protocol, request.config, request.model),
        instructions: request.instructions,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        stopSequences: request.protocol !== "responses" && request.stopSequences?.length ? request.stopSequences : undefined,
        providerOptions: request.providerOptions as never,
        abortSignal: request.signal,
        // 重试 / 换 key / fallback 由 llm.ts 负责
        maxRetries: 0,
    };
    try {
        if (!streaming) {
            const result = await generateText(options);
            return {
                text: truncateAtStop(result.text, request.stopSequences),
                reasoning: textReasoning(result.reasoning),
                usage: result.usage,
                finishReason: result.finishReason,
                rawFinishReason: result.rawFinishReason,
                providerMetadata: result.providerMetadata,
            };
        }
        const label = PROTOCOL_LABEL[request.protocol];
        const incomplete = () => new Error(`${label} stream ended before completion from model ${request.model}`);
        const result = streamText({ ...options, onError: () => undefined });
        let finished = false;
        for await (const part of result.fullStream) {
            if (part.type === "error") {
                request.signal?.throwIfAborted();
                // SDK 对缺少完成事件的流报 InvalidResponseDataError
                if (InvalidResponseDataError.isInstance(part.error) && /without a finish reason/i.test(part.error.message)) throw incomplete();
                throw part.error;
            }
            if (part.type === "finish") {
                if (part.finishReason === "error" || part.rawFinishReason === "error") throw new Error(`${label} stream failed from model ${request.model}`);
                // 未收到完成事件时 SDK 报 { unified: "other", raw: undefined }；Responses 正常完成时 raw 为空、unified 为 stop
                finished = part.rawFinishReason != null || part.finishReason !== "other";
            }
        }
        // SDK 不会把取消前累积的半截输出当错误：取消一律抛出
        request.signal?.throwIfAborted();
        if (!finished) throw incomplete();
        return {
            text: truncateAtStop(await result.text, request.stopSequences),
            reasoning: textReasoning(await result.reasoning),
            usage: await result.totalUsage,
            finishReason: await result.finishReason,
            rawFinishReason: await result.rawFinishReason,
            providerMetadata: await result.providerMetadata,
        };
    } catch (error) {
        if (APICallError.isInstance(error) && error.statusCode != null) {
            throw new SdkHttpError(
                (toLLMError(request.protocol, error, request.model) as Error).message,
                error.statusCode,
                error.responseBody ?? "",
            );
        }
        throw toLLMError(request.protocol, error, request.model);
    }
}

function textReasoning(parts: ReadonlyArray<{ type: string; text?: string; providerMetadata?: ProviderMetadata }>): SdkResult["reasoning"] {
    return parts
        .filter((part) => part.type === "reasoning")
        .map((part) => ({ text: part.text ?? "", providerMetadata: part.providerMetadata }));
}

/** 在第一个 stop 序列处截断（不含 stop 本身），模拟 Chat Completions 的 stop 语义 */
export function truncateAtStop(text: string, stop?: string[]): string {
    let end = text.length;
    for (const s of stop ?? []) {
        if (!s) continue;
        const i = text.indexOf(s);
        if (i >= 0 && i < end) end = i;
    }
    return text.slice(0, end);
}

/** 用户消息（含多模态图片：data URL 或 http(s) URL） */
export function userMessage(m: ChatMessage, providerOptions?: ModelMessage["providerOptions"]): ModelMessage {
    if (!m.imageParts?.length) return { role: "user", content: m.content, providerOptions };
    return {
        role: "user",
        content: [
            { type: "text", text: m.content },
            ...m.imageParts.map((img) => ({
                type: "file" as const,
                data: new URL(img.url),
                mediaType: /^data:(image\/[^;,]+)/.exec(img.url)?.[1] ?? "image",
                ...(img.detail ? { providerOptions: { openai: { imageDetail: img.detail } } } : {}),
            })),
        ],
        providerOptions,
    };
}

/** 统一 usage；Anthropic 的 promptTokens 沿用原始 input_tokens（不含缓存读写） */
export function usageFrom(protocol: Protocol, result: SdkResult): LLMResponse["usage"] {
    const raw = result.providerMetadata?.anthropic?.usage as Record<string, any> | undefined;
    if (protocol === "anthropic" && raw) {
        return {
            promptTokens: raw.input_tokens,
            completionTokens: raw.output_tokens,
            totalTokens: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
            cachedTokens: raw.cache_read_input_tokens ?? undefined,
            cacheCreationTokens: raw.cache_creation_input_tokens ?? undefined,
            reasoningTokens: raw.output_tokens_details?.thinking_tokens,
        };
    }
    const u = result.usage;
    if (u.inputTokens == null && u.outputTokens == null) return undefined;
    return {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        cachedTokens: u.inputTokenDetails?.cacheReadTokens,
        reasoningTokens: u.outputTokenDetails?.reasoningTokens,
    };
}

/** 空输出视为失败（llm.ts 以 "empty response" 识别并重试） */
export function requireContent(text: string, model: string): string {
    if (!text) throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    return text;
}
