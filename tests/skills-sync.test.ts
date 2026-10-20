import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    computeSkillsGeneration,
    invalidateSkillsGeneration,
    isSyncBackPathAllowed,
    packSkills,
    syncBackSkills,
} from "../src/sandbox/skills/skills-sync.js";
import { SkillsStore } from "../src/sandbox/remote/skills-store.js";

let dir = "";

before(() => {
    dir = mkdtempSync(join(tmpdir(), "cgm-skills-sync-"));
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("computeSkillsGeneration", () => {
    it("is stable, ignores the deps hash file and changes when files change", () => {
        const skills = join(dir, "gen");
        mkdirSync(join(skills, "a"), { recursive: true });
        writeFileSync(join(skills, "a", "index.ts"), "export const x = 1;\n");
        invalidateSkillsGeneration();
        const g1 = computeSkillsGeneration(skills);
        writeFileSync(join(skills, ".skills-deps-hash"), "abc");
        invalidateSkillsGeneration();
        assert.equal(computeSkillsGeneration(skills).hash, g1.hash);
        writeFileSync(join(skills, "a", "index.ts"), "export const x = 22;\n");
        invalidateSkillsGeneration();
        assert.notEqual(computeSkillsGeneration(skills).hash, g1.hash);
        // 缓存：未失效前返回同一结果
        writeFileSync(join(skills, "a", "extra.ts"), "");
        assert.equal(computeSkillsGeneration(skills).hash, computeSkillsGeneration(skills).hash);
    });
});

describe("packSkills + SkillsStore", () => {
    it("round-trips a skills tree and strips symlinks that escape the tree", async () => {
        const skills = join(dir, "pack");
        mkdirSync(join(skills, "hello"), { recursive: true });
        mkdirSync(join(skills, "node_modules", ".bin"), { recursive: true });
        mkdirSync(join(skills, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(skills, "hello", "index.ts"), "export const hi = 1;\n");
        writeFileSync(join(skills, "node_modules", "pkg", "cli.js"), "#!/usr/bin/env node\n");
        symlinkSync("../pkg/cli.js", join(skills, "node_modules", ".bin", "pkg"));
        symlinkSync("/etc/passwd", join(skills, "hello", "evil"));

        const chunks: Buffer[] = [];
        for await (const c of packSkills(skills)) chunks.push(c as Buffer);
        const tar = Buffer.concat(chunks);
        assert.ok(tar.length > 0);

        const store = new SkillsStore(join(dir, "store"), 10 * 1024 * 1024, 2);
        const hash = "a".repeat(64);
        const upload = await store.beginUpload(hash);
        await upload.write(0, tar.toString("base64"));
        const { createHash } = await import("node:crypto");
        await upload.finish(createHash("sha256").update(tar).digest("hex"));
        const root = store.pathFor(hash);
        assert.equal(readFileSync(join(root, "hello", "index.ts"), "utf-8"), "export const hi = 1;\n");
        assert.ok(existsSync(join(root, "node_modules", ".bin", "pkg")), "relative in-tree symlink kept");
        assert.equal(existsSync(join(root, "hello", "evil")), false, "escaping symlink removed");
        assert.equal(spawnSync("test", ["-L", join(root, "hello", "evil")]).status, 1);
        assert.ok(store.has(hash));
    });

    it("rejects out-of-order chunks, oversize archives and checksum mismatches", async () => {
        const store = new SkillsStore(join(dir, "store2"), 10, 2);
        const up1 = await store.beginUpload("b".repeat(64));
        await assert.rejects(up1.write(1, "AA=="), /out of order/);
        await up1.abort();
        const up2 = await store.beginUpload("c".repeat(64));
        await assert.rejects(up2.write(0, Buffer.alloc(20).toString("base64")), /too large/);
        await up2.abort();
        const up3 = await store.beginUpload("d".repeat(64));
        await up3.write(0, Buffer.from("x").toString("base64"));
        await assert.rejects(up3.finish("0".repeat(64)), /checksum/);
        assert.throws(() => store.pathFor("../../etc"), /invalid skills hash/);
    });
});

describe("syncBackSkills", () => {
    it("applies the allowlist and replaces skills atomically", async () => {
        const skills = join(dir, "syncback");
        mkdirSync(join(skills, "mine"), { recursive: true });
        writeFileSync(join(skills, "mine", "old.ts"), "old");
        const files: Record<string, Record<string, string>> = {
            mine: {
                "index.ts": "export const v = 2;",
                "mine.d.ts": "export declare const v: number;",
                "package.json": "{\"scripts\":{\"postinstall\":\"curl evil\"}}",
                "bin/tool": "#!/bin/sh",
                "node_modules/x/index.js": "evil",
                "big.md": "x".repeat(300 * 1024),
            },
        };
        const report = await syncBackSkills({
            list: async (id) => Object.keys(files[id] ?? {}),
            read: async (id, rel, max) => {
                const data = Buffer.from(files[id][rel]);
                if (data.length > max) throw new Error("file too large");
                return data;
            },
        }, skills, ["mine", "../escape"]);
        assert.deepEqual(report.synced, ["mine"]);
        assert.equal(readFileSync(join(skills, "mine", "index.ts"), "utf-8"), "export const v = 2;");
        assert.equal(existsSync(join(skills, "mine", "old.ts")), false);
        assert.equal(existsSync(join(skills, "mine", "package.json")), false);
        assert.equal(existsSync(join(skills, "mine", "node_modules")), false);
        const reasons = report.rejected.map((r) => `${r.path}:${r.reason}`).join("\n");
        assert.match(reasons, /package\.json:dependency manifests/);
        assert.match(reasons, /bin\/tool:extension/);
        assert.match(reasons, /big\.md:file too large/);
        assert.match(reasons, /\.\.\/escape:invalid skill id/);
    });

    it("isSyncBackPathAllowed rejects traversal and hidden segments", () => {
        assert.equal(isSyncBackPathAllowed("a/b.ts"), null);
        assert.notEqual(isSyncBackPathAllowed("../a.ts"), null);
        assert.notEqual(isSyncBackPathAllowed(".npmrc"), null);
        assert.notEqual(isSyncBackPathAllowed("a/.hidden.ts"), null);
    });
});
