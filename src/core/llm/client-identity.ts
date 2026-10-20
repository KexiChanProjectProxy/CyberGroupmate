/**
 * llm/client-identity.ts — 让 LLM 请求的 User-Agent 与会话标识头和指定客户端保持一致
 *
 * 目前只支持 "opencode"：对齐 sst/opencode（a62028d）packages/core/src/session/model-request.ts
 * 在每个模型请求上设置的头：
 *   x-opencode-session-id / x-session-affinity / X-Session-Id / x-opencode-session = 会话 id（ses_…）
 *   User-Agent = opencode/<channel>/<version>/<name>（正式版 CLI：channel=latest，name=cli）
 *   x-opencode-project = 项目 id（非 git 目录为 "global"）
 *   x-opencode-client = <name>
 * 会话 id 按 opencode 的 Identifier.descending() 生成（"ses_" + 12 位倒序时间十六进制 + 14 位 base62 随机）。
 * opencode 的每个请求都属于某个会话：多轮会话传入稳定的 sessionId，单次调用每次生成新的会话 id。
 */

import { webcrypto } from "node:crypto";

export type ClientIdentity = "opencode";

const OPENCODE_APP = { name: "cli", channel: "latest", version: "2.1.1" } as const;
const OPENCODE_PROJECT = "global";

const ID_LENGTH = 26;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTimestamp = 0;
let counter = 0;

/** opencode Identifier.descending() 的移植：时间越新排序越靠前 */
export function opencodeSessionId(timestamp = Date.now()): string {
    if (timestamp !== lastTimestamp) {
        lastTimestamp = timestamp;
        counter = 0;
    }
    counter++;
    const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter));
    const time = Array.from({ length: 6 }, (_, index) =>
        Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0"),
    ).join("");
    const bytes = webcrypto.getRandomValues(new Uint8Array(ID_LENGTH - 12));
    return "ses_" + time + Array.from(bytes, (byte) => BASE62[byte % 62]).join("");
}

/** 本地会话 id（ULID）→ opencode 风格会话 id；同一会话内保持稳定 */
const sessionIds = new Map<string, string>();
const MAX_TRACKED_SESSIONS = 2000;

function sessionIdFor(localSessionId: string | undefined): string {
    if (!localSessionId) return opencodeSessionId();
    let id = sessionIds.get(localSessionId);
    if (!id) {
        id = opencodeSessionId();
        sessionIds.set(localSessionId, id);
        if (sessionIds.size > MAX_TRACKED_SESSIONS) {
            sessionIds.delete(sessionIds.keys().next().value as string);
        }
    }
    return id;
}

/** 生成某个客户端身份对应的请求头（键名大小写与 opencode 一致） */
export function clientIdentityHeaders(identity: ClientIdentity, localSessionId?: string): Record<string, string> {
    const session = sessionIdFor(localSessionId);
    return {
        "x-opencode-session-id": session,
        "x-session-affinity": session,
        "X-Session-Id": session,
        "User-Agent": `opencode/${OPENCODE_APP.channel}/${OPENCODE_APP.version}/${OPENCODE_APP.name}`,
        "x-opencode-project": OPENCODE_PROJECT,
        "x-opencode-session": session,
        "x-opencode-client": OPENCODE_APP.name,
    };
}
