/**
 * context-engine/providers/pipeline-providers.ts — Recording Pipeline & Grounding Providers
 *
 * 这些是一次性调用的场景（无历史积累），全部 volatile/ephemeral。
 * 但仍然使用 provider 模式以保持统一的数据管理。
 */

import type { SectionProvider, SectionSchema } from "../types.js";
import { loadPromptFile } from "../../core/prompt-loader.js";
import { renderTemplate } from "../template-engine.js";

// ═══ Topic Clustering Provider ═══

export interface TopicClusteringData {
    existingTopics: string;
    messages: string;
}

export const topicClusteringProvider: SectionProvider<TopicClusteringData> = {
    schema: {
        name: "topic_clustering",
        label: "话题聚类",
        source: "pipeline.recording",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx) {
        return {
            existingTopics: (ctx.existingTopics as string) ?? "",
            messages: (ctx.messages as string) ?? "",
        };
    },
    render(data) {
        return [
            "你是一个消息话题分析器。",
            "请分析以下消息，将每条消息归属到一个话题中。",
            "",
            "已有话题列表（如果有的话）：",
            data.existingTopics,
            "",
            "新消息列表：",
            data.messages,
            "",
            "请输出 JSON 格式：",
            "{",
            '  "assignments": [',
            '    { "messageId": "<字符串消息ID>", "topicId": "<已有话题ID或NEW_1/NEW_2等>", "topicLabel": "<仅新话题>", "keywords": ["<仅新话题>"] }',
            "  ],",
            '  "evolutions": [',
            '    { "parentTopicId": "<父话题ID>", "newTopicLabel": "<新话题标签>", "reason": "<演变原因>" }',
            "  ]",
            "}",
            "",
            "规则：",
            "- 如果消息属于已有话题，直接用已有话题 ID",
            "- 不是每一条消息都必定属于一个话题，如果某消息相对孤立，与当前上下文无关、之前也没出现过，请直接跳过。",
            "- 如果是全新话题，必须且只能使用 NEW_1, NEW_2 等具有 `NEW_` 前缀的临时 ID（例如 `NEW_1`），严禁使用自己编造的英文字符串作为 ID，且需提供 topicLabel 和 keywords。属性每个话题只需要在第一条消息处输出一次。",
            "- 如果话题从已有话题演变而来（内容明显偏移但有关联），在 evolutions 中记录",
            "- topicLabel 应为 3-5 个词，概括话题主旨",
            "- 只输出 JSON，不要其他内容",
        ].join("\n");
    },
};

// ═══ Topic Triage Provider ═══

export interface TopicTriageData {
    personaName: string;
    persona: string;
    rules: string;
}

const TOPIC_TRIAGE_PROMPT_PATH = "pipeline/topic-triage.md";

const DEFAULT_TOPIC_TRIAGE_PROMPT = [
    `你是「{{personaName}}」，正在回顾最近的对话记录，并为每个话题补充摘要和后续行动提示。`,
    "",
    "{{persona}}",
    "",
    "{{#rules}}",
    "补充规则：",
    "{{rules}}",
    "",
    "{{/rules}}",
    "判断原则：",
    "- 符合自述、准则、人设",
    "- 技术类话题（网络、硬件、系统、协议、排障、选型、安全补丁等）：只有讨论已经来回持续了一段时间、并且仍然没有任何结论或可执行结果时，才 shouldSignal=true。刚出现的问题、还在互相补充信息、已有人在答、已经有结果、或仅仅是一条没人理的悬空提问，一律 shouldSignal=false。",
    "- 应进入信号池：自己之前答应过但还没回复的请求、关系很好的人的闲聊、明显可以接上历史记忆/回梗的机会、需要稍后由 Meta 判断是否派发的非技术开放话题。",
    "- 不应进入信号池：悬空（没有人理睬）但讨论尚未展开或尚未卡住的提问、用户已经收到回应或问题已解决、只需等待对方自然反应、话题已经自然结束、没有可行动空间、技术讨论仍在进行或刚刚开始。",
    "- 绝不介入：争吵、自己未参与过的话题、不熟悉的人的话题、私密对话、敏感话题、已有专业人士在解答、和你关系不好的人的话题",
    "- 私聊：对方点名你、或还在等你答应过的结果时可以回应。不要因为最后一句是自己说的、对方没回，就再追一句。话题结束太久不追问。",
    "- shouldSignal 表示是否进入 Layer 2 信号池；它不是立即回复决定，只表示值得让 Meta 之后慢慢消费和判断。进入信号池也不等于回一句话：技术话题若要派发，必须是讨论已卡住且能把判断说完。",
    "",
    "请输出 JSON 格式：",
    "{",
    '  "topics": [',
    "    {",
    '      "topicId": "<话题ID>",',
    '      "summary": "<2-3句话摘要，和标题不重复>",',
    '      "shouldSignal": true,',
    '      "reason": "<为什么应/不应进入信号池；若 shouldSignal=true，写清 Meta 后续可判断的行动方向>"',
    "    }",
    "  ]",
    "}",
].join("\n");

export const topicTriageProvider: SectionProvider<TopicTriageData> = {
    schema: {
        name: "topic_triage",
        label: "话题分诊",
        source: "pipeline.triage",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx) {
        const personaName = ctx.personaName as string | undefined;
        const persona = ctx.persona as string | undefined;
        if (!personaName) return null;
        return {
            personaName,
            persona: persona ?? "",
            rules: (ctx.rules as string) ?? "",
        };
    },
    render(data) {
        const template = loadPromptFile(TOPIC_TRIAGE_PROMPT_PATH) ?? DEFAULT_TOPIC_TRIAGE_PROMPT;
        return renderTemplate(template, { ...data });
    },
};

// ═══ Grounding Provider ═══

export interface GroundingData {
    sanitizedText: string;
}

export const groundingProvider: SectionProvider<GroundingData> = {
    schema: {
        name: "grounding",
        label: "事实查证",
        source: "grounding.input",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx) {
        const text = ctx.sanitizedText as string | undefined;
        if (!text) return null;
        return { sanitizedText: text };
    },
    render(data) {
        return [
            "你是一个事实查证助手。请根据以下对话内容，识别其中涉及真实世界的事实性话题（新闻事件、科技产品、人物、组织、数据、日期等），并**使用搜索工具**查证相关信息，补充聊天中未覆盖的部分或者与事实不符的部分。",
            "",
            "要求：",
            "1. 重点关注对话中**有争议**或**需要验证**的事实性陈述",
            '2. 如果对话纯粹是闲聊、情感交流或没有事实性内容，直接说明"无需查证"',
            "3. 查证结果请以简洁的要点形式输出，标注来源",
            "4. 不要重复对话内容，只输出查证结论",
            "",
            "## 对话内容",
            "",
            data.sanitizedText,
        ].join("\n");
    },
};

// ═══ Callback Provider ═══

export interface CallbackData {
    chatId: string;
    chatType: string;
    chatTitle: string;
    taskId: string;
    executionType: string;
    status: string;
    durationMs: number;
    isCompleted: boolean;
    sentMessages: string;
    summary: string;
    error?: string;
}

export const callbackProvider: SectionProvider<CallbackData> = {
    schema: {
        name: "callback",
        label: "执行回调",
        source: "subagent.callback",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx) {
        const cb = ctx.callback as CallbackData | undefined;
        return cb ?? null;
    },
    render(data) {
        const lines = [
            `═══ 消息回复结果 ═══`,
            `群组: ${data.chatTitle} (${data.chatId}) [${data.chatType}]`,
            `任务: ${data.taskId} (${data.executionType})`,
            `状态: ${data.status}`,
            `耗时: ${data.durationMs}ms`,
        ];
        if (data.isCompleted) {
            lines.push("", "已发送消息:", data.sentMessages, "Session 运行状况：", data.summary);
        }
        if (data.error) {
            lines.push("", `错误: ${data.error}`);
        }
        lines.push("", "请根据已发送消息分析：刚才的行为是否OOC、违背自己的准则或设定，是否达成目标，并且在下一次决策时纠正。");
        return lines.join("\n");
    },
};
