/**
 * limits.ts — Sandbox ↔ Host 协议上限
 *
 * 威胁模型：sandbox worker 视为完全受攻击者控制（RCE）。
 * 这里的上限全部在 host 侧强制执行，worker 侧的同名检查只是友好提示，不构成安全边界。
 */

export const PROTOCOL_LIMITS = {
    /** worker → host 单行 NDJSON 最大字节数；超出即视为协议违规并终止 worker */
    maxLineBytes: 4 * 1024 * 1024,
    /** result.output 最大字符数（超出截断） */
    maxOutputChars: 1024 * 1024,
    /** host_call args 序列化后最大字节数 */
    maxHostCallArgsBytes: 1024 * 1024,
    /** 同时处理中的 host_call 上限（超出立即返回错误） */
    maxConcurrentHostCalls: 8,
    /** host_call method 名最大长度 */
    maxMethodLength: 128,
    /** 请求 / host_call id 最大长度 */
    maxIdLength: 128,
    /** runtime.input() prompt 最大字符数 */
    maxPromptChars: 4 * 1024,
    /** print / stderr 单条最大字符数 */
    maxPrintChars: 16 * 1024,
    /** notify 事件序列化后最大字节数（超出丢弃） */
    maxNotifyBytes: 64 * 1024,
    /** notify / print 令牌桶：每秒补充 */
    eventRatePerSecond: 50,
    /** notify / print 令牌桶：桶容量 */
    eventBurst: 200,
    /** 单次 result 允许的 extendSteps 上限 */
    maxExtendSteps: 100,
    /** runtime.modifyTimeout 允许范围 */
    minTimeoutMs: 1000,
    maxTimeoutMs: 600_000,
    /** 每分钟允许的无效帧（不可解析 / 未知类型 / schema 不符）数量，超出终止 worker */
    maxInvalidFramesPerMinute: 10,
} as const;

export type ProtocolLimits = { -readonly [K in keyof typeof PROTOCOL_LIMITS]: number };

export function resolveLimits(overrides?: Partial<ProtocolLimits>): ProtocolLimits {
    return { ...PROTOCOL_LIMITS, ...(overrides ?? {}) };
}
