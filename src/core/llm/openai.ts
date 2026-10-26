/**
 * llm/openai.ts — OpenAI 兼容 Chat Completions 调用（经 @ai-sdk/openai-compatible）
 *
 * 用 openai-compatible 而不是 @ai-sdk/openai 的 chat 模型：网关 / DeepSeek 等返回的 reasoning_content
 * （及其别名 reasoning）只有前者解析并回传。
 */

import type { ModelMessage } from "ai";
import type { LLMConfig } from "../config.js";
import { requireContent, runSdkRequest, usageFrom, userMessage } from "./ai-sdk.js";
import { reasoningOriginKey } from "./reasoning-origin.js";
import type { ChatMessage, LLMResponse } from "./types.js";

/**
 * 调用 OpenAI 兼容 API
 */
export async function callOpenAI(
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

    const instructions = messages
        .filter((m) => m.role === "system")
        .map((m) => ({ role: "system" as const, content: m.content }));
    const apiMessages: ModelMessage[] = messages.filter((m) => m.role !== "system").map((m): ModelMessage => {
        if (m.role === "user") return userMessage(m);
        // reasoning_content 虽然是明文、不像 Responses item id 那样会被判非法格式，
        // 但部分上游（如 DeepSeek）明确拒绝 input 里带该字段，同样按 profile 隔离。
        if (m.reasoning?.provider === "openai_chat" && m.reasoning.originKey === originKey) {
            return {
                role: "assistant",
                content: [
                    { type: "reasoning", text: m.reasoning.content },
                    { type: "text", text: m.content },
                ],
            };
        }
        return { role: "assistant", content: m.content };
    });
    // Prefill: 追加 assistant 消息作为生成起点
    if (prefill) apiMessages.push({ role: "assistant", content: prefill });

    const result = await runSdkRequest({
        protocol: "chat",
        config,
        model,
        instructions: instructions.length ? instructions : undefined,
        messages: apiMessages,
        temperature: config.omit_temperature ? undefined : temperature,
        maxOutputTokens: maxTokens,
        stopSequences: stop,
        providerOptions: thinkingLevel && thinkingLevel !== "none"
            ? { openaiCompatible: { reasoningEffort: thinkingLevel } }
            : undefined,
        signal,
    }, config.chatRequestMode === "stream");

    const content = requireContent(result.text, model);
    const reasoningContent = result.reasoning.map((part) => part.text).join("");
    const usage = usageFrom("chat", result);

    return {
        content,
        reasoning: reasoningContent
            ? { provider: "openai_chat", content: reasoningContent, originKey, tokenCount: usage?.reasoningTokens }
            : undefined,
        usage,
    };
}
