/**
 * media-downloader.ts — 媒体文件下载与管理
 *
 * 负责：
 * - 将下载的媒体 Buffer 按类型保存到 workspace/Downloads/
 * - 按 uniqueFileId 去重（已存在则跳过）；贴纸额外按文件内容去重
 * - 3 天（可配）自动清理过期文件
 *
 * 目录结构：
 *   workspace/Downloads/
 *     photos/      platform_chatId_msgId_uniqueFileId.jpg
 *     videos/      platform_chatId_msgId_uniqueFileId.mp4
 *     stickers/    platform_chatId_msgId_uniqueFileId.webp
 *     documents/   platform_chatId_msgId_uniqueFileId.pdf
 *     other/       platform_chatId_msgId_uniqueFileId.bin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import mime from "mime-to-extensions";
import { createLogger } from "./logger.js";

const log = createLogger("media-downloader");

// ─── 类型 ───

export type MediaCategory = "photos" | "videos" | "stickers" | "documents" | "other";

export interface MediaFileInfo {
    /** 磁盘绝对路径 */
    path: string;
    /** 分类目录名 */
    category: MediaCategory;
    /** MIME 类型 */
    mimeType?: string;
    /** 文件大小 bytes */
    size: number;
    /** 文件内容 SHA256，仅对需要稳定内容身份的媒体填充 */
    contentHash?: string;
}

export interface MediaSaveOptions {
    chatId?: string;
    messageId?: string;
    uniqueFileId: string;
    mediaType: string;
    mimeType?: string;
    /** 原始文件名（如 Telegram document.fileName），用于提取扩展名 */
    fileName?: string;
}

export interface MediaDownloaderConfig {
    /** 下载根目录。默认 "workspace/Downloads"，会被 resolve 为绝对路径 */
    downloadDir?: string;
    /** 文件保留天数。默认 3 */
    retentionDays?: number;
    /** 文件大小上限 (bytes)。默认 20MB */
    maxFileSize?: number;
}

// ─── 常量 ───

const DEFAULT_DOWNLOAD_DIR = "workspace/Downloads";
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** mediaType → 分类目录 */
function categorize(mediaType: string): MediaCategory {
    switch (mediaType) {
        case "photo": return "photos";
        case "video": return "videos";
        case "sticker": return "stickers";
        case "document": return "documents";
        case "animation": return "other";
        default: return "other";
    }
}

/**
 * 解析文件扩展名（优先级：fileName → mime-db → .bin）
 */
function resolveExt(mimeType?: string, fileName?: string): string {
    // 1. 优先从原始文件名提取扩展名
    if (fileName) {
        const dotIdx = fileName.lastIndexOf(".");
        if (dotIdx > 0) {
            return fileName.slice(dotIdx).toLowerCase();
        }
    }
    // 2. 通过 mime-db 查询
    if (mimeType) {
        const ext = mime.extension(mimeType);
        if (ext) return `.${ext}`;
    }
    // 3. fallback
    return ".bin";
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath: string): string {
    return sha256(fs.readFileSync(filePath));
}

function isStickerPath(filePath: string): boolean {
    return path.basename(path.dirname(filePath)) === "stickers";
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

// ─── MediaDownloader ───

export class MediaDownloader {
    private readonly downloadDir: string;
    private readonly manifestPath: string;
    private readonly retentionDays: number;
    private readonly maxFileSize: number;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    /** uniqueFileId → absolute path 索引 (内存) */
    private readonly pathIndex = new Map<string, string>();
    /** sticker content SHA256 → absolute path 索引 (内存) */
    private readonly stickerContentIndex = new Map<string, string>();
    /** uniqueFileId → sticker content SHA256 索引 (内存) */
    private readonly stickerAliasContentHashes = new Map<string, string>();
    private readonly indexedStickerPaths = new Set<string>();
    private readonly savedListeners: Array<(info: MediaFileInfo & { chatId?: string }) => void> = [];

    constructor(config?: MediaDownloaderConfig) {
        // 始终 resolve 为绝对路径，确保从任意 cwd 都能正确访问
        this.downloadDir = path.resolve(config?.downloadDir ?? DEFAULT_DOWNLOAD_DIR);
        this.manifestPath = path.join(this.downloadDir, "_manifest.json");
        this.retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS;
        this.maxFileSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

        // 确保目录存在
        for (const cat of ["photos", "videos", "stickers", "documents", "other"] as MediaCategory[]) {
            const dir = path.join(this.downloadDir, cat);
            try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
        }

        // 启动清理 + 建立索引
        this.rebuildIndex();
        this.cleanupExpired();

        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired();
        }, CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    /**
     * 文件大小是否在下载限制内
     */
    isWithinSizeLimit(fileSize?: number): boolean {
        if (fileSize == null) return true; // 未知大小 → 尝试下载
        return fileSize <= this.maxFileSize;
    }

    /**
     * 获取最大文件大小限制 (bytes)
     */
    getMaxFileSize(): number {
        return this.maxFileSize;
    }

    /**
     * 检查文件是否已下载，返回路径或 null
     */
    getExistingPath(uniqueFileId: string): string | null {
        return this.pathIndex.get(uniqueFileId) ?? null;
    }

    /**
     * 保存媒体文件到磁盘
     *
     * @returns 保存信息 (路径、大小等)，或 null 如果超出大小限制
     */
    saveMedia(buffer: Buffer, opts: MediaSaveOptions): MediaFileInfo | null {
        const info = this.saveMediaInternal(buffer, opts);
        if (info && this.savedListeners.length > 0) {
            for (const listener of this.savedListeners) {
                try {
                    listener({ ...info, chatId: opts.chatId });
                } catch (err) {
                    log.warn("saveMedia: onSaved 回调异常", { error: String(err) });
                }
            }
        }
        return info;
    }

    /**
     * 注册保存成功回调（remote sandbox 据此把入站媒体推送到对应 chat 的 sandbox）
     * @returns 取消注册的函数
     */
    onSaved(listener: (info: MediaFileInfo & { chatId?: string }) => void): () => void {
        this.savedListeners.push(listener);
        return () => {
            const idx = this.savedListeners.indexOf(listener);
            if (idx >= 0) this.savedListeners.splice(idx, 1);
        };
    }

    /** 下载根目录（绝对路径） */
    getDownloadDir(): string {
        return this.downloadDir;
    }

    private saveMediaInternal(buffer: Buffer, opts: MediaSaveOptions): MediaFileInfo | null {
        // 大小检查
        if (buffer.length > this.maxFileSize) {
            log.debug("saveMedia: 超出大小限制", {
                uniqueFileId: opts.uniqueFileId,
                size: buffer.length,
                limit: this.maxFileSize,
            });
            return null;
        }

        const category = categorize(opts.mediaType);
        const contentHash = category === "stickers" ? sha256(buffer) : undefined;

        // 去重
        const existing = this.pathIndex.get(opts.uniqueFileId);
        if (existing) {
            try {
                if (fs.existsSync(existing)) {
                    const stat = fs.statSync(existing);
                    if (contentHash && isStickerPath(existing)) {
                        this.stickerContentIndex.set(contentHash, existing);
                        this.stickerAliasContentHashes.set(opts.uniqueFileId, contentHash);
                        this.indexedStickerPaths.add(existing);
                    }
                    return {
                        path: existing,
                        category,
                        mimeType: opts.mimeType,
                        size: stat.size,
                        contentHash,
                    };
                }
            } catch { /* 文件可能已被清理 */ }
            this.pathIndex.delete(opts.uniqueFileId);
            this.stickerAliasContentHashes.delete(opts.uniqueFileId);
        }

        if (contentHash) {
            const duplicatePath = this.stickerContentIndex.get(contentHash);
            try {
                if (duplicatePath && fs.existsSync(duplicatePath)) {
                    this.pathIndex.set(opts.uniqueFileId, duplicatePath);
                    this.stickerAliasContentHashes.set(opts.uniqueFileId, contentHash);
                    this.saveManifest();
                    log.debug("saveMedia: 贴纸内容已存在，复用文件", {
                        uniqueFileId: opts.uniqueFileId,
                        contentHash,
                        filePath: duplicatePath,
                        size: buffer.length,
                    });
                    return {
                        path: duplicatePath,
                        category,
                        mimeType: opts.mimeType,
                        size: buffer.length,
                        contentHash,
                    };
                }
            } catch { /* stale index entry */ }
            this.stickerContentIndex.delete(contentHash);
        }

        const ext = resolveExt(opts.mimeType, opts.fileName);
        const chatId = (opts.chatId ?? "unknown").replace(/:/g, "_");
        const msgId = opts.messageId ?? "0";
        // 清理 uniqueFileId 中的非法文件名字符
        const safeUniqueId = opts.uniqueFileId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${chatId}_${msgId}_${safeUniqueId}${ext}`;
        const filePath = path.join(this.downloadDir, category, fileName);

        try {
            fs.writeFileSync(filePath, buffer);
            this.pathIndex.set(opts.uniqueFileId, filePath);
            if (contentHash) {
                this.stickerContentIndex.set(contentHash, filePath);
                this.stickerAliasContentHashes.set(opts.uniqueFileId, contentHash);
                this.indexedStickerPaths.add(filePath);
            }
            this.saveManifest();
            log.debug("saveMedia: 已保存", { filePath, size: buffer.length });
            return {
                path: filePath,
                category,
                mimeType: opts.mimeType,
                size: buffer.length,
                contentHash,
            };
        } catch (err) {
            log.warn("saveMedia: 写入失败", { filePath, error: String(err) });
            return null;
        }
    }

    private indexStickerContent(filePath: string, contentHash?: string): string | null {
        if (!isStickerPath(filePath)) return null;
        if (contentHash) {
            if (!this.stickerContentIndex.has(contentHash)) {
                this.stickerContentIndex.set(contentHash, filePath);
            }
            this.indexedStickerPaths.add(filePath);
            return contentHash;
        }
        if (this.indexedStickerPaths.has(filePath)) {
            for (const [hash, indexedPath] of this.stickerContentIndex.entries()) {
                if (indexedPath === filePath) return hash;
            }
        }
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return null;
            const hash = sha256File(filePath);
            if (!this.stickerContentIndex.has(hash)) {
                this.stickerContentIndex.set(hash, filePath);
            }
            this.indexedStickerPaths.add(filePath);
            return hash;
        } catch {
            /* stale manifest entry */
            return null;
        }
    }

    /**
     * 清理超过保留期的文件
     */
    cleanupExpired(): void {
        const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        let removed = 0;

        // 贴纸文件永久保留，不参与清理
        for (const cat of ["photos", "videos", "documents", "other"]) {
            const dir = path.join(this.downloadDir, cat);
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.isFile() && stat.mtimeMs < cutoffMs) {
                            fs.unlinkSync(filePath);
                            removed++;
                            // 从索引中移除
                            for (const [key, val] of this.pathIndex.entries()) {
                                if (val === filePath) {
                                    this.pathIndex.delete(key);
                                    break;
                                }
                            }
                        }
                    } catch { /* skip individual files */ }
                }
            } catch { /* dir might not exist yet */ }
        }

        if (removed > 0) {
            this.saveManifest();
            log.info("cleanupExpired: 已清理过期文件", { removed, retentionDays: this.retentionDays });
        }
    }

    private loadManifest(): boolean {
        try {
            if (!fs.existsSync(this.manifestPath)) return false;
            const raw = JSON.parse(fs.readFileSync(this.manifestPath, "utf-8"));
            if (typeof raw !== "object" || raw === null) return false;
            const meta = recordValue((raw as Record<string, unknown>)._meta);
            const stickerContentHashes = recordValue(meta?.stickerContentHashes);
            let loaded = 0;
            for (const [uniqueFileId, filePath] of Object.entries(raw)) {
                if (uniqueFileId.startsWith("_")) continue;
                if (typeof filePath !== "string") continue;
                if (fs.existsSync(filePath)) {
                    this.pathIndex.set(uniqueFileId, filePath);
                    const hash = typeof stickerContentHashes?.[uniqueFileId] === "string"
                        ? stickerContentHashes[uniqueFileId]
                        : undefined;
                    const indexedHash = this.indexStickerContent(filePath, hash);
                    if (indexedHash) this.stickerAliasContentHashes.set(uniqueFileId, indexedHash);
                    loaded++;
                }
            }
            log.debug("loadManifest: 已加载", { loaded });
            return loaded > 0;
        } catch (err) {
            log.warn("loadManifest: 读取失败", { error: String(err) });
            return false;
        }
    }

    private saveManifest(): void {
        try {
            const obj: Record<string, unknown> = {};
            const stickerContentHashes: Record<string, string> = {};
            for (const [k, v] of this.pathIndex.entries()) {
                obj[k] = v;
                const hash = this.getStickerContentHashForManifest(k, v);
                if (hash) stickerContentHashes[k] = hash;
            }
            if (Object.keys(stickerContentHashes).length > 0) {
                obj._meta = {
                    version: 2,
                    stickerContentHashes,
                };
            }
            fs.writeFileSync(this.manifestPath, JSON.stringify(obj, null, 2));
        } catch (err) {
            log.warn("saveManifest: 写入失败", { error: String(err) });
        }
    }

    private getStickerContentHashForManifest(uniqueFileId: string, filePath: string): string | null {
        if (!isStickerPath(filePath)) return null;
        const existing = this.stickerAliasContentHashes.get(uniqueFileId);
        if (existing) return existing;
        const hash = this.indexStickerContent(filePath);
        if (!hash) return null;
        this.stickerAliasContentHashes.set(uniqueFileId, hash);
        return hash;
    }

    /**
     * 从 manifest + 磁盘重建 uniqueFileId → path 索引
     */
    private rebuildIndex(): void {
        this.loadManifest();

        // 回退：扫描磁盘文件，补充 manifest 中缺失的条目
        let added = 0;
        for (const cat of ["photos", "videos", "stickers", "documents", "other"]) {
            const dir = path.join(this.downloadDir, cat);
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (file.startsWith("_")) continue;
                    const dotIndex = file.lastIndexOf(".");
                    const base = dotIndex > 0 ? file.slice(0, dotIndex) : file;
                    const parts = base.split("_");
                    if (parts.length >= 4) {
                        const uniqueFileId = parts.slice(3).join("_");
                        if (!this.pathIndex.has(uniqueFileId)) {
                            this.pathIndex.set(uniqueFileId, path.join(dir, file));
                            added++;
                        }
                        const indexedHash = this.indexStickerContent(path.join(dir, file));
                        if (indexedHash) this.stickerAliasContentHashes.set(uniqueFileId, indexedHash);
                    }
                }
            } catch { /* ignore */ }
        }

        if (this.pathIndex.size > 0) {
            log.debug("rebuildIndex: 已索引文件", { count: this.pathIndex.size, addedFromDisk: added });
        }
        if (added > 0) {
            this.saveManifest();
        }
    }

    /**
     * 停止定时清理
     */
    dispose(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
}
