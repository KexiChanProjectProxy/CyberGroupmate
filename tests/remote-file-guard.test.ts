/**
 * remote-file-guard.test.ts — remote sandbox 的文件通道：sandbox 路径拉取 / 宿主路径拒绝 / 内网 URL 拒绝
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    InboxStore,
    pullFromSandbox,
    pushToSandbox,
    rewriteRemoteFileArgs,
    toWorkspaceRelative,
    type SandboxFileTransport,
} from "../src/sandbox/files/sandbox-files.js";
import { InboundMediaRelay } from "../src/sandbox/files/inbound-media.js";

const originalCwd = process.cwd();
let hostDir = "";
let sandboxHome = "";

/** 用本地目录模拟 sandbox home 的文件传输 */
function fakeSandbox(chatId = "telegram:-1"): SandboxFileTransport & { isAlive(): boolean; isRemote(): boolean; writes: string[] } {
    const writes: string[] = [];
    const inHome = (p: string) => {
        const abs = resolve(sandboxHome, p);
        const rel = relative(sandboxHome, abs);
        if (!rel || rel.startsWith("..")) throw new Error("path outside sandbox home");
        return abs;
    };
    return {
        writes,
        getChatId: () => chatId,
        getSandboxHome: () => sandboxHome,
        isAlive: () => true,
        isRemote: () => true,
        statFile: async (p) => {
            try {
                const abs = inHome(p);
                const data = readFileSync(abs);
                return { size: data.length, isFile: true, path: abs };
            } catch {
                return null;
            }
        },
        readFileChunk: async (p, offset, length) => {
            const data = readFileSync(inHome(p));
            const chunk = data.subarray(offset, offset + length);
            return { data: chunk, eof: offset + chunk.length >= data.length, size: data.length };
        },
        writeFileChunk: async (p, data, append) => {
            const abs = inHome(p);
            mkdirSync(join(abs, ".."), { recursive: true });
            writes.push(p);
            if (append) writeFileSync(abs, Buffer.concat([readFileSync(abs), data]));
            else writeFileSync(abs, data);
        },
    };
}

before(() => {
    hostDir = mkdtempSync(join(tmpdir(), "cgm-file-guard-host-"));
    sandboxHome = mkdtempSync(join(tmpdir(), "cgm-file-guard-sbx-"));
    mkdirSync(join(hostDir, "workspace"), { recursive: true });
    writeFileSync(join(hostDir, "config.yaml"), "secret: true\n");
    writeFileSync(join(hostDir, "workspace", "memory.db"), "sqlite");
    mkdirSync(join(sandboxHome, "media"), { recursive: true });
    writeFileSync(join(sandboxHome, "media", "out.png"), Buffer.alloc(3000, 1));
    process.chdir(hostDir);
});

after(() => {
    process.chdir(originalCwd);
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(sandboxHome, { recursive: true, force: true });
});

describe("rewriteRemoteFileArgs", () => {
    it("pulls sandbox files (absolute, file:// and relative) into the host inbox", async () => {
        const sb = fakeSandbox();
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        const abs = join(sandboxHome, "media", "out.png");
        const [chat, media, opts] = await rewriteRemoteFileArgs(
            ["-100", { type: "photo", file: abs }, { thumb: `file://${abs}`, extra: ["media/out.png"] }],
            sb,
            inbox,
        ) as [string, { file: string }, { thumb: string; extra: string[] }];
        assert.equal(chat, "-100");
        for (const p of [media.file, opts.thumb, opts.extra[0]]) {
            assert.ok(inbox.contains(p), p);
            assert.equal(readFileSync(p).length, 3000);
        }
        // 同一路径只拉取一次
        assert.equal(media.file, opts.thumb);
    });

    it("rejects references to host files (absolute or workspace-relative)", async () => {
        const sb = fakeSandbox();
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        for (const ref of [join(hostDir, "config.yaml"), "config.yaml", "memory.db", "workspace/memory.db", "/etc/passwd", `file://${join(hostDir, "config.yaml")}`]) {
            await assert.rejects(rewriteRemoteFileArgs(["-100", ref], sb, inbox), /不能引用宿主文件/, ref);
        }
    });

    it("rejects URLs that would make the host fetch internal addresses", async () => {
        const sb = fakeSandbox();
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        for (const url of [
            "http://169.254.169.254/computeMetadata/v1/",
            "http://metadata.google.internal/x",
            "http://127.0.0.1:9090/metrics",
            "https://10.0.0.5/a.png",
            "http://[::1]/x",
            "http://localhost:3000/",
        ]) {
            await assert.rejects(rewriteRemoteFileArgs(["-100", { file: url }], sb, inbox), /内网地址/, url);
        }
        const [, ok] = await rewriteRemoteFileArgs(["-100", { file: "https://example.com/a.png" }], sb, inbox) as [string, { file: string }];
        assert.equal(ok.file, "https://example.com/a.png");
    });

    it("leaves plain text alone", async () => {
        const sb = fakeSandbox();
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        const text = "看看 config.yaml 和 /etc/passwd 是什么";
        const [, out] = await rewriteRemoteFileArgs(["-100", text, { caption: "hello world" }], sb, inbox);
        assert.equal(out, text);
    });

    it("enforces the pull size limit", async () => {
        const sb = fakeSandbox();
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        await assert.rejects(rewriteRemoteFileArgs(["-100", "media/out.png"], sb, inbox, { maxBytes: 100 }), /文件过大/);
    });
});

describe("push / pull helpers", () => {
    it("round-trips multi-chunk files", async () => {
        const sb = fakeSandbox();
        const big = Buffer.alloc(2_300_000);
        for (let i = 0; i < big.length; i++) big[i] = i % 251;
        const hostFile = join(hostDir, "big.bin");
        writeFileSync(hostFile, big);
        const sandboxPath = await pushToSandbox(sb, hostFile, "Downloads/big.bin");
        assert.equal(sandboxPath, join(sandboxHome, "Downloads/big.bin"));
        assert.ok(readFileSync(join(sandboxHome, "Downloads/big.bin")).equals(big));
        const inbox = new InboxStore(join(hostDir, "workspace", ".sandbox-inbox"));
        const pulled = await pullFromSandbox(sb, "Downloads/big.bin", inbox);
        assert.ok(readFileSync(pulled).equals(big));
    });

    it("inbox sweep removes expired files", async () => {
        const inbox = new InboxStore(join(hostDir, "inbox-sweep"), 1000);
        const p = inbox.allocate("telegram:-9", "a.txt");
        writeFileSync(p, "x");
        utimesSync(p, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
        inbox.sweep();
        assert.equal(existsSync(p), false);
    });

    it("toWorkspaceRelative only maps files inside workspace", () => {
        const ws = join(hostDir, "workspace");
        assert.equal(toWorkspaceRelative(join(ws, "Downloads", "photos", "a.jpg"), ws), "Downloads/photos/a.jpg");
        assert.equal(toWorkspaceRelative(join(hostDir, "config.yaml"), ws), null);
    });
});

describe("InboundMediaRelay", () => {
    it("pushes saved media to live sandboxes of the same chat and replays recent media on ready", async () => {
        const ws = join(hostDir, "workspace");
        mkdirSync(join(ws, "Downloads", "photos"), { recursive: true });
        const photo = join(ws, "Downloads", "photos", "p1.jpg");
        writeFileSync(photo, "jpeg");
        const live = fakeSandbox("telegram:-200");
        const relay = new InboundMediaRelay((chatId) => (chatId.endsWith("-200") ? [live] : []), ws);
        relay.onSaved({ path: photo, size: 4, chatId: "-200" });
        // 推送是异步的：等待落盘（并行跑全量测试时可能较慢）
        const target = join(sandboxHome, "Downloads/photos/p1.jpg");
        for (let i = 0; i < 200 && !existsSync(target); i++) await new Promise((r) => setTimeout(r, 25));
        assert.equal(readFileSync(target, "utf-8"), "jpeg");

        const fresh = fakeSandbox("telegram:-200");
        await relay.onSandboxReady(fresh);
        assert.deepEqual(fresh.writes, ["Downloads/photos/p1.jpg"]);

        const other = fakeSandbox("telegram:-300");
        await relay.onSandboxReady(other);
        assert.deepEqual(other.writes, []);
    });
});
