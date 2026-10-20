/**
 * inbound-media.ts — remote 模式下把 host 下载的入站媒体推送到对应 chat 的 sandbox
 *
 * host 的 MediaDownloader 把平台媒体保存到 workspace/Downloads/<category>/…，
 * 提示词里展示的是 workspace 相对路径（Downloads/…）。local 模式下 worker cwd 即 workspace，
 * 路径天然可用；remote 模式下需要把文件推送到 sandbox home 的同一相对路径。
 */

import { createLogger } from "../../core/logger.js";
import { getRawId } from "../../core/chat-id.js";
import { pushToSandbox, toWorkspaceRelative, type SandboxFileTransport } from "./sandbox-files.js";

const log = createLogger("sandbox-inbound");

const RECENT_PER_CHAT = 30;
const PUSH_ON_START_MAX_BYTES = 100 * 1024 * 1024;

export interface InboundSandbox extends SandboxFileTransport {
    isAlive(): boolean;
    isRemote(): boolean;
}

interface RecentFile {
    path: string;
    size: number;
}

export class InboundMediaRelay {
    private readonly recent = new Map<string, RecentFile[]>();
    private readonly pushed = new WeakMap<object, Set<string>>();

    constructor(
        private readonly findLiveSandboxes: (chatId: string) => InboundSandbox[],
        private readonly workspaceDir: string,
    ) {}

    private key(chatId: string): string {
        return getRawId(chatId);
    }

    /** MediaDownloader.onSaved 回调 */
    onSaved(info: { path: string; size: number; chatId?: string }): void {
        if (!info.chatId) return;
        if (!toWorkspaceRelative(info.path, this.workspaceDir)) return;
        const key = this.key(info.chatId);
        const list = (this.recent.get(key) ?? []).filter((f) => f.path !== info.path);
        list.push({ path: info.path, size: info.size });
        if (list.length > RECENT_PER_CHAT) list.splice(0, list.length - RECENT_PER_CHAT);
        this.recent.set(key, list);
        for (const sandbox of this.findLiveSandboxes(info.chatId)) {
            void this.push(sandbox, info.path);
        }
    }

    /** sandbox 就绪时推送该 chat 最近的入站媒体（新者优先，总量有上限） */
    async onSandboxReady(sandbox: InboundSandbox): Promise<void> {
        const list = this.recent.get(this.key(sandbox.getChatId())) ?? [];
        let budget = PUSH_ON_START_MAX_BYTES;
        for (const file of [...list].reverse()) {
            if (file.size > budget) continue;
            budget -= file.size;
            await this.push(sandbox, file.path);
        }
    }

    private async push(sandbox: InboundSandbox, hostPath: string): Promise<void> {
        if (!sandbox.isRemote() || !sandbox.isAlive()) return;
        const rel = toWorkspaceRelative(hostPath, this.workspaceDir);
        if (!rel) return;
        let done = this.pushed.get(sandbox);
        if (!done) {
            done = new Set();
            this.pushed.set(sandbox, done);
        }
        if (done.has(rel)) return;
        done.add(rel);
        try {
            await pushToSandbox(sandbox, hostPath, rel);
        } catch (err) {
            done.delete(rel);
            log.warn("推送入站媒体到 sandbox 失败", { chatId: sandbox.getChatId(), file: rel, error: String(err) });
        }
    }
}
