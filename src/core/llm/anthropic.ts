/**
 * llm/anthropic.ts — Anthropic Messages API 调用（经 @ai-sdk/anthropic）
 */

import type { ModelMessage, ProviderMetadata } from "ai";
import type { LLMConfig } from "../config.js";
import { requireContent, runSdkRequest, SdkHttpError, usageFrom, userMessage } from "./ai-sdk.js";
import { reasoningOriginKey } from "./reasoning-origin.js";
import type { ChatMessage, LLMResponse } from "./types.js";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

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
    const originKey = reasoningOriginKey(config, model);
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");
    const thinkingEnabled = Boolean(thinkingLevel && thinkingLevel !== "none");

    // includeReasoning=false 时不回传 thinking block（签名失效时的重试）
    const buildMessages = (includeReasoning: boolean): ModelMessage[] => {
        const list: ModelMessage[] = [];
        for (const m of nonSystemMsgs) {
            const cache = m.cacheBreakpoint ? EPHEMERAL : undefined;
            if (m.role === "user") {
                list.push(userMessage(m, cache));
                continue;
            }
            // 只回传本 profile 自己签发的 thinking block：signature 只对签发它的上游有效。
            if (includeReasoning && m.reasoning?.provider === "anthropic" && m.reasoning.originKey === originKey) {
                list.push({
                    role: "assistant",
                    content: [
                        ...m.reasoning.blocks.map(thinkingBlockToPart),
                        { type: "text", text: m.content },
                    ],
                    providerOptions: cache,
                });
                continue;
            }
            list.push({ role: "assistant", content: m.content, providerOptions: cache });
        }
        // Prefill: 追加 assistant 消息作为生成起点。
        // Anthropic 不允许 assistant prefill 与 extended/adaptive thinking 同时使用；
        // callLLM 外层仍会把 prefill 拼回最终 content，保持调用方返回值语义不变。
        if (prefill && !thinkingEnabled) list.push({ role: "assistant", content: prefill });
        return list;
    };

    const request = (includeReasoning: boolean) => runSdkRequest({
        protocol: "anthropic",
        config,
        model,
        instructions: systemMsg ? { role: "system", content: systemMsg.content, providerOptions: EPHEMERAL } : undefined,
        messages: buildMessages(includeReasoning),
        temperature: config.omit_temperature ? undefined : temperature,
        maxOutputTokens: maxTokens,
        stopSequences: stop,
        providerOptions: {
            anthropic: thinkingEnabled
                ? { thinking: { type: "adaptive" }, effort: toAnthropicEffort(thinkingLevel) }
                : {},
        },
        signal,
    }, config.chatRequestMode === "stream");

    let result;
    try {
        result = await request(true);
    } catch (error) {
        // 回传的 thinking block 签名失效（如上下文被压缩 / 改写后前缀不再一致）：去掉 thinking block 重试一次
        const signatureRejected = error instanceof SdkHttpError && error.statusCode === 400
            && /signature/i.test(error.responseBody) && /thinking/i.test(error.responseBody);
        if (!signatureRejected || !nonSystemMsgs.some((m) => m.reasoning?.provider === "anthropic")) throw error;
        result = await request(false);
    }

    // 安全分类器拦截：同样的输入重试也会被拒，直接抛出（不是 empty response，不会在同一 profile 上重试），
    // 交给 callLLMWithFallback 换下一个 profile
    if (result.rawFinishReason === "refusal") {
        const details = result.providerMetadata?.anthropic?.stopDetails as { category?: string } | undefined;
        throw new Error(`Anthropic refusal from model ${model} (category=${details?.category ?? "unknown"})`);
    }

    const content = requireContent(result.text, model);
    const blocks = result.reasoning.map((part) => partToThinkingBlock(part.text, part.providerMetadata));
    const usage = usageFrom("anthropic", result);

    return {
        content,
        reasoning: blocks.length
            ? { provider: "anthropic", blocks, originKey, tokenCount: usage?.reasoningTokens }
            : undefined,
        usage,
    };
}

/** 持久化的 thinking / redacted_thinking block → SDK reasoning part */
function thinkingBlockToPart(block: Record<string, unknown>) {
    if (block.type === "redacted_thinking") {
        return { type: "reasoning" as const, text: "", providerOptions: { anthropic: { redactedData: String(block.data ?? "") } } };
    }
    return {
        type: "reasoning" as const,
        text: String(block.thinking ?? ""),
        providerOptions: { anthropic: { signature: String(block.signature ?? "") } },
    };
}

/** SDK reasoning part → 与 Messages API 原样一致的 thinking / redacted_thinking block */
function partToThinkingBlock(text: string, metadata?: ProviderMetadata): Record<string, unknown> {
    const meta = metadata?.anthropic as { signature?: string; redactedData?: string } | undefined;
    if (meta?.redactedData != null) return { type: "redacted_thinking", data: meta.redactedData };
    return { type: "thinking", thinking: text, ...(meta?.signature != null ? { signature: meta.signature } : {}) };
}

function toAnthropicEffort(value?: string): "low" | "medium" | "high" | "max" {
    if (value === "low" || value === "high" || value === "max") return value;
    if (value === "xhigh") return "max";
    return "medium";
}
