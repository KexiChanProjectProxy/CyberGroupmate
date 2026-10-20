/**
 * notify-guard.ts — sandbox notify 事件的 host 侧过滤
 *
 * sandbox 的 notify 事件会进入 NotificationCenter；NC 的消费者会把
 * `nc.message` 当作入站用户消息、把 `system.agent_message_sent` 写入目标 chat 的消息日志。
 * 若不加过滤，受控的 sandbox 可以伪造任意 chat / 任意用户的消息。
 *
 * 规则：
 * - `system.agent_message_sent`：必须消耗一个 SendLedger 凭证——即 host 刚刚替该 sandbox
 *   成功执行过一次指向同一 chat 的写操作（host-call-handler 授予），否则丢弃。
 * - `system.duplicate_message_blocked` / `system.banned_word_blocked`：仅为提示信息，
 *   chatId 固定为绑定 chat，原目标放入 targetChatId。
 * - 保留前缀（nc. / im. / system. / 平台名.）的其他类型：改写为 `sandbox.notify`，原类型放入 originalType。
 * - 其余自定义类型保留 type。
 * - 所有放行的事件：chatId 固定为绑定 chat，并标记 `_source: "sandbox"`。
 */

import { ensureCompositeId, isValidCompositeChatId, type PlatformName } from "../core/chat-id.js";

const PLATFORMS: ReadonlySet<string> = new Set<PlatformName>(["telegram", "discord", "onebot", "feishu"]);
const RESERVED_TYPE_PREFIXES = ["nc.", "im.", "system.", "telegram.", "discord.", "onebot.", "qq.", "feishu."];
const INFO_TYPES = new Set(["system.duplicate_message_blocked", "system.banned_word_blocked"]);
const PASSTHROUGH_SYSTEM_TYPES = new Set(["system.background_error"]);

const MAX_TYPE_LENGTH = 128;
const CREDIT_TTL_MS = 10 * 60_000;
const MAX_CREDITS = 256;

interface SendCredit {
    chatId: string;
    messageId?: string;
    expiresAt: number;
}

function normalizeMessageId(value: unknown): string | undefined {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
}

/** 从 adapter 写操作返回值中提取消息 id（单条或数组） */
export function extractSentMessageIds(result: unknown): Array<string | undefined> {
    const one = (item: unknown): string | undefined => {
        if (!item || typeof item !== "object") return undefined;
        const rec = item as Record<string, unknown>;
        return normalizeMessageId(rec.id ?? rec.messageId ?? rec.message_id);
    };
    if (Array.isArray(result)) return result.length > 0 ? result.map(one) : [undefined];
    const ids = [one(result)];
    // 飞书 sendMedia 可能附带额外消息（additionalMessages），worker 会为每条额外消息各发一个事件
    const additional = result && typeof result === "object" ? (result as Record<string, unknown>).additionalMessages : undefined;
    if (Array.isArray(additional)) {
        for (const item of additional.slice(0, 32)) ids.push(one(item));
    }
    return ids;
}

/**
 * 每个 Sandbox 一个：host 成功执行写操作时授予凭证，agent_message_sent 事件消耗凭证。
 */
export class SendLedger {
    private credits: SendCredit[] = [];

    constructor(private readonly now: () => number = Date.now) {}

    grant(compositeChatId: string, messageId?: string): void {
        this.prune();
        this.credits.push({ chatId: compositeChatId, messageId, expiresAt: this.now() + CREDIT_TTL_MS });
        if (this.credits.length > MAX_CREDITS) this.credits.splice(0, this.credits.length - MAX_CREDITS);
    }

    consume(compositeChatId: string, messageId?: string): boolean {
        this.prune();
        let index = -1;
        if (messageId) {
            index = this.credits.findIndex((c) => c.chatId === compositeChatId && c.messageId === messageId);
        }
        if (index === -1) {
            // 事件未带 messageId，或凭证未记录 messageId（部分 adapter 不返回 id）
            index = this.credits.findIndex((c) => c.chatId === compositeChatId && (!messageId || !c.messageId));
        }
        if (index === -1) return false;
        this.credits.splice(index, 1);
        return true;
    }

    get size(): number {
        this.prune();
        return this.credits.length;
    }

    private prune(): void {
        const now = this.now();
        if (this.credits.length > 0 && this.credits[0].expiresAt <= now) {
            this.credits = this.credits.filter((c) => c.expiresAt > now);
        }
    }
}

export type NotifyGuardResult =
    | { ok: true; event: Record<string, unknown> }
    | { ok: false; reason: string };

function resolveTargetChat(event: Record<string, unknown>): string | null {
    const scene = typeof event.scene === "string" ? event.scene : "";
    const rawChatId = typeof event.chatId === "string" || typeof event.chatId === "number" ? String(event.chatId) : "";
    if (!rawChatId) return null;
    if (isValidCompositeChatId(rawChatId)) return rawChatId;
    if (!PLATFORMS.has(scene)) return null;
    return ensureCompositeId(scene as PlatformName, rawChatId);
}

export function guardSandboxNotify(
    event: Record<string, unknown>,
    ctx: { boundChatId: string; ledger: SendLedger },
): NotifyGuardResult {
    const type = typeof event.type === "string" ? event.type.trim() : "";
    if (!type || type.length > MAX_TYPE_LENGTH) {
        return { ok: false, reason: "notify event requires a short string type" };
    }

    if (type === "system.agent_message_sent") {
        const target = resolveTargetChat(event);
        if (!target) return { ok: false, reason: "agent_message_sent without resolvable chatId/scene" };
        if (!ctx.ledger.consume(target, normalizeMessageId(event.messageId))) {
            return { ok: false, reason: `agent_message_sent for ${target} has no matching host-side send` };
        }
        return { ok: true, event: { ...event, type, _source: "sandbox" } };
    }

    if (INFO_TYPES.has(type)) {
        return {
            ok: true,
            event: { ...event, type, chatId: ctx.boundChatId, targetChatId: event.chatId, _source: "sandbox" },
        };
    }

    const reserved = !PASSTHROUGH_SYSTEM_TYPES.has(type) && RESERVED_TYPE_PREFIXES.some((p) => type.startsWith(p));
    return {
        ok: true,
        event: {
            ...event,
            type: reserved ? "sandbox.notify" : type,
            ...(reserved ? { originalType: type } : {}),
            chatId: ctx.boundChatId,
            _source: "sandbox",
        },
    };
}
