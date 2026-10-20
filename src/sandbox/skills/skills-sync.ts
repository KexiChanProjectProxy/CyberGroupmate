/**
 * skills-sync.ts — host 侧 skills 的版本计算、打包与（可选）回传
 *
 * remote 模式下 host 的 workspace/skills 是唯一权威：
 * - computeSkillsGeneration：对目录清单（路径 + 大小 + mtime）做 sha256，作为 generation；
 * - packSkills：tar 打包整个目录（含 host 用 --ignore-scripts 安装的 node_modules）；
 * - syncBackSkills：可选（sandbox.skills_sync_back），把 sandbox 内 agent 编写的 skill
 *   源码按白名单拉回 host。默认关闭——回传意味着攻击者可控的文本进入 host 的提示词与 harness 读取范围。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

const IGNORED_TOP_LEVEL = new Set([".skills-deps-hash"]);
const MAX_MANIFEST_ENTRIES = 200_000;

export interface SkillsGeneration {
    hash: string;
    files: number;
    bytes: number;
}

let cached: { dir: string; generation: SkillsGeneration } | null = null;

export function invalidateSkillsGeneration(): void {
    cached = null;
}

/** 计算 skills 目录的 generation（缓存，直到 invalidateSkillsGeneration） */
export function computeSkillsGeneration(skillsDir: string): SkillsGeneration {
    if (cached && cached.dir === skillsDir) return cached.generation;
    const hash = createHash("sha256");
    let files = 0;
    let bytes = 0;
    const walk = (dir: string) => {
        let entries: string[];
        try {
            entries = readdirSync(dir).sort();
        } catch {
            return;
        }
        for (const name of entries) {
            const full = join(dir, name);
            const rel = relative(skillsDir, full);
            if (dir === skillsDir && (IGNORED_TOP_LEVEL.has(name) || name.startsWith(".skills-install-"))) continue;
            let st;
            try {
                st = lstatSync(full);
            } catch {
                continue;
            }
            if (++files > MAX_MANIFEST_ENTRIES) throw new Error("skills 目录文件过多");
            if (st.isDirectory()) {
                hash.update(`d ${rel}\n`);
                walk(full);
            } else if (st.isSymbolicLink()) {
                hash.update(`l ${rel}\n`);
            } else if (st.isFile()) {
                bytes += st.size;
                hash.update(`f ${rel} ${st.size} ${Math.floor(st.mtimeMs)}\n`);
            }
        }
    };
    if (existsSync(skillsDir)) walk(skillsDir);
    const generation = { hash: hash.digest("hex"), files, bytes };
    cached = { dir: skillsDir, generation };
    return generation;
}

/** tar 打包 skills 目录（不跟随符号链接，不含 deps hash 文件） */
export function packSkills(skillsDir: string): Readable {
    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
    const child = spawn("tar", ["-C", skillsDir, "--exclude=./.skills-deps-hash", "--exclude=./.skills-install-*", "-cf", "-", "."], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
    });
    child.stderr?.resume();
    return child.stdout!;
}

// ─── 可选：sandbox → host 回传 ───

export const SYNC_BACK_ALLOWLIST = {
    extensions: new Set([".ts", ".js", ".mjs", ".cjs", ".d.ts", ".md", ".json", ".py", ".sh", ".txt", ".yaml", ".yml"]),
    maxFileBytes: 256 * 1024,
    maxSkillBytes: 5 * 1024 * 1024,
    maxFilesPerSkill: 200,
};

export interface SyncBackFileSource {
    /** 列出 sandbox 内某 skill 目录下的相对文件路径 */
    list(skillId: string): Promise<string[]>;
    /** 读取 sandbox 内 skills/<skillId>/<rel>，超过 maxBytes 抛错 */
    read(skillId: string, rel: string, maxBytes: number): Promise<Buffer>;
}

function isSafeSegment(segment: string): boolean {
    return segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\0") && !segment.startsWith(".");
}

export function isSyncBackPathAllowed(rel: string): string | null {
    const parts = rel.split(/[\\/]/);
    if (!parts.every(isSafeSegment)) return "unsafe path segment";
    if (parts.includes("node_modules")) return "node_modules is host-managed";
    const base = parts[parts.length - 1];
    if (base === "package.json" || base === "package-lock.json" || base === ".npmrc") return "dependency manifests are host-managed";
    const ext = base.endsWith(".d.ts") ? ".d.ts" : extname(base);
    if (!SYNC_BACK_ALLOWLIST.extensions.has(ext)) return `extension ${ext || "(none)"} not allowed`;
    return null;
}

export async function syncBackSkills(
    source: SyncBackFileSource,
    skillsDir: string,
    skillIds: string[],
): Promise<{ synced: string[]; rejected: Array<{ path: string; reason: string }> }> {
    const synced: string[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    for (const skillId of skillIds) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(skillId)) {
            rejected.push({ path: skillId, reason: "invalid skill id" });
            continue;
        }
        const files = (await source.list(skillId)).slice(0, SYNC_BACK_ALLOWLIST.maxFilesPerSkill + 1);
        if (files.length > SYNC_BACK_ALLOWLIST.maxFilesPerSkill) {
            rejected.push({ path: skillId, reason: "too many files" });
            continue;
        }
        const staged: Array<{ rel: string; data: Buffer }> = [];
        let total = 0;
        let failed = false;
        for (const rel of files) {
            const reason = isSyncBackPathAllowed(rel);
            if (reason) {
                rejected.push({ path: `${skillId}/${rel}`, reason });
                continue;
            }
            try {
                const data = await source.read(skillId, rel, SYNC_BACK_ALLOWLIST.maxFileBytes);
                total += data.length;
                if (total > SYNC_BACK_ALLOWLIST.maxSkillBytes) {
                    rejected.push({ path: skillId, reason: "skill too large" });
                    failed = true;
                    break;
                }
                staged.push({ rel, data });
            } catch (err) {
                rejected.push({ path: `${skillId}/${rel}`, reason: err instanceof Error ? err.message : String(err) });
            }
        }
        if (failed || staged.length === 0) continue;
        // 原子替换：先写临时目录，再整体 rename（不触碰 host 安装的 node_modules）
        const target = join(skillsDir, skillId);
        const tmp = join(skillsDir, `.sync-${skillId}-${process.pid}-${Date.now()}`);
        rmSync(tmp, { recursive: true, force: true });
        for (const { rel, data } of staged) {
            const dest = join(tmp, rel);
            if (!dest.startsWith(tmp + sep)) continue;
            mkdirSync(join(dest, ".."), { recursive: true });
            writeFileSync(dest, data);
        }
        rmSync(target, { recursive: true, force: true });
        renameSync(tmp, target);
        synced.push(skillId);
    }
    if (synced.length > 0) invalidateSkillsGeneration();
    return { synced, rejected };
}
