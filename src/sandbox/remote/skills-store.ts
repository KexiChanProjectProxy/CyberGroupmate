/**
 * skills-store.ts — sandboxd 侧按 generation 存储 host 推送的 skills（只读挂载给容器）
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class SkillsStore {
    readonly root: string;

    constructor(dataDir: string, private readonly maxBytes: number, private readonly keep: number) {
        this.root = join(dataDir, "skills");
        mkdirSync(this.root, { recursive: true, mode: 0o755 });
    }

    pathFor(hash: string): string {
        if (!/^[a-f0-9]{16,64}$/.test(hash)) throw new Error("invalid skills hash");
        return join(this.root, hash);
    }

    has(hash: string): boolean {
        const p = this.pathFor(hash);
        if (!existsSync(p)) return false;
        try { utimesSync(p, new Date(), new Date()); } catch { /* ignore */ }
        return true;
    }

    /** 开始接收一个 generation：返回逐块写入器 */
    async beginUpload(hash: string): Promise<SkillsUpload> {
        this.pathFor(hash);
        const tmpTar = join(this.root, `.incoming-${randomBytes(8).toString("hex")}.tar`);
        const handle = await open(tmpTar, "wx", 0o600);
        return new SkillsUpload(this, hash, tmpTar, handle, this.maxBytes);
    }

    /** 解包到临时目录、清理、原子落位 */
    async install(hash: string, tarPath: string): Promise<void> {
        const target = this.pathFor(hash);
        const tmpDir = join(this.root, `.extract-${randomBytes(8).toString("hex")}`);
        mkdirSync(tmpDir, { mode: 0o755 });
        try {
            await runTar(["-xf", tarPath, "-C", tmpDir, "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"]);
            sanitizeTree(tmpDir);
            if (existsSync(target)) return; // 并发上传：已有同一 generation
            renameSync(tmpDir, target);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
            rmSync(tarPath, { force: true });
        }
        this.gc(new Set([hash]));
    }

    /** 保留最近使用的 keep 个 generation（inUse 中的永不删除） */
    gc(inUse: Set<string>): void {
        const entries = readdirSync(this.root)
            .filter((name) => /^[a-f0-9]{16,64}$/.test(name))
            .map((name) => ({ name, mtime: statSync(join(this.root, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        for (const entry of entries.slice(this.keep)) {
            if (inUse.has(entry.name)) continue;
            rmSync(join(this.root, entry.name), { recursive: true, force: true });
        }
        for (const name of readdirSync(this.root)) {
            if (name.startsWith(".incoming-") || name.startsWith(".extract-")) {
                const full = join(this.root, name);
                try {
                    if (Date.now() - statSync(full).mtimeMs > 3_600_000) rmSync(full, { recursive: true, force: true });
                } catch { /* ignore */ }
            }
        }
    }
}

export class SkillsUpload {
    private bytes = 0;
    private nextSeq = 0;
    private readonly hasher = createHash("sha256");

    constructor(
        private readonly store: SkillsStore,
        private readonly hash: string,
        private readonly tarPath: string,
        private readonly handle: FileHandle,
        private readonly maxBytes: number,
    ) {}

    async write(seq: number, base64: string): Promise<void> {
        if (seq !== this.nextSeq++) throw new Error("skills chunk out of order");
        const data = Buffer.from(base64, "base64");
        this.bytes += data.length;
        if (this.bytes > this.maxBytes) throw new Error("skills archive too large");
        this.hasher.update(data);
        await this.handle.write(data);
    }

    async finish(sha256: string): Promise<void> {
        await this.handle.close();
        if (this.hasher.digest("hex") !== sha256) {
            rmSync(this.tarPath, { force: true });
            throw new Error("skills archive checksum mismatch");
        }
        await this.store.install(this.hash, this.tarPath);
    }

    async abort(): Promise<void> {
        try { await this.handle.close(); } catch { /* ignore */ }
        rmSync(this.tarPath, { force: true });
    }
}

function runTar(args: string[]): Promise<void> {
    return new Promise((resolveTar, reject) => {
        const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolveTar() : reject(new Error(`tar failed (${code}): ${stderr}`))));
    });
}

/**
 * 解包后清理：只保留普通文件、目录与指向树内的相对符号链接；去掉 setuid/setgid/写权限。
 */
function sanitizeTree(root: string): void {
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = lstatSync(full);
            if (st.isSymbolicLink()) {
                const target = readlinkSync(full);
                const resolved = isAbsolute(target) ? target : resolve(dirname(full), target);
                const rel = relative(root, resolved);
                if (isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) unlinkSync(full);
            } else if (st.isDirectory()) {
                chmodSync(full, 0o755);
                walk(full);
            } else if (st.isFile()) {
                chmodSync(full, (st.mode & 0o111) ? 0o755 : 0o644);
            } else {
                rmSync(full, { force: true });
            }
        }
    };
    chmodSync(root, 0o755);
    walk(root);
}
