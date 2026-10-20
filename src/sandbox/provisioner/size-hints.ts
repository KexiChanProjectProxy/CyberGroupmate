/**
 * size-hints.ts — agent 对 sandbox VM 规格的 hint（runtime.sandboxSize）
 *
 * 每个 chat 一台 VM，home 随 VM 丢弃：不能为了换规格中途重建 VM（会丢失正在进行的工作），
 * 因此 hint 只对该 chat 的下一台 VM 生效，2 小时后过期回到默认规格。
 */

const HINT_TTL_MS = 2 * 3_600_000;

export const DEFAULT_SIZES: Record<string, string> = {
    small: "c4-standard-2",
    medium: "c4-standard-4",
    large: "c4-standard-8",
};

const hints = new Map<string, { size: string; expiresAt: number }>();

export function setSizeHint(chatId: string, size: string, now = Date.now()): void {
    hints.set(chatId, { size, expiresAt: now + HINT_TTL_MS });
}

export function getSizeHint(chatId: string, now = Date.now()): string | undefined {
    const hint = hints.get(chatId);
    if (!hint) return undefined;
    if (hint.expiresAt <= now) {
        hints.delete(chatId);
        return undefined;
    }
    return hint.size;
}

export function clearSizeHints(): void {
    hints.clear();
}
