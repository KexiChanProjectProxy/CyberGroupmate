/**
 * sandbox-ephemeral.test.ts — 每个 chat 一台临时 VM：host → broker（模拟 Cloud Run）→ sandboxd（VPC 内纯 TCP）
 *
 * sandboxd 用 ProcessLauncher 在本机运行；broker 是一个模拟的 HTTP 服务，"创建 VM" 即返回 127.0.0.1。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Sandboxd } from "../src/sandbox/remote/sandboxd.js";
import { parseSandboxdConfig } from "../src/sandbox/remote/sandboxd-config.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { buildSandboxRuntime } from "../src/sandbox/runtime-config.js";
import { BrokerClient } from "../src/sandbox/provisioner/broker-client.js";
import { clearSizeHints, setSizeHint } from "../src/sandbox/provisioner/size-hints.js";
import { remoteControlRequest } from "../src/sandbox/transport/remote-transport.js";

let dir = "";
let daemon: Sandboxd;
let sandboxdPort = 0;
let brokerServer: Server;
let brokerUrl = "";
const brokerLog: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
const vms = new Map<string, { zone: string; polls: number }>();
let exhaustedRegions = new Set<string>();
const sandboxes: Sandbox[] = [];

function runtime() {
    return buildSandboxRuntime({
        mode: "remote",
        inheritHostEnv: false,
        skillsSyncBack: false,
        readyTimeoutMs: 30_000,
        remote: {
            endpoints: [],
            connectTimeoutMs: 5_000,
            pingIntervalMs: 2_000,
            provisioner: {
                brokerUrl,
                regions: ["region-cheap1", "region-mid1"],
                sizes: { small: "c4-standard-2", large: "c4-standard-8" },
                defaultSize: "small",
                port: sandboxdPort,
                vmReadyTimeoutMs: 60_000,
                priceCacheFile: join(dir, "prices.json"),
            },
        },
    }, join(dir, "skills"), { broker: new BrokerClient(brokerUrl, async (aud) => `id-token-for:${aud}`), prices: null });
}

before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cgm-ephemeral-"));
    const cfg = parseSandboxdConfig({ listen: { host: "127.0.0.1", port: 0 }, data_dir: join(dir, "sbx"), launcher: "process", max_sessions: 4 });
    daemon = new Sandboxd(cfg);
    sandboxdPort = (await daemon.listen()).port!;

    brokerServer = createServer(async (req, res) => {
        const url = new URL(req.url!, "http://x");
        let body: any;
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
        brokerLog.push({ method: req.method!, path: url.pathname, body, auth: req.headers.authorization });
        const send = (status: number, payload?: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(payload ? JSON.stringify(payload) : ""); };
        if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
            if (exhaustedRegions.has(body.region)) return send(503, { error: "no_capacity", message: "stockout" });
            const name = `cgm-sbx-${vms.size + 1}`;
            vms.set(name, { zone: `${body.region}-a`, polls: 0 });
            return send(201, { name, zone: `${body.region}-a`, region: body.region, machineType: body.machineType });
        }
        const m = /^\/v1\/sandboxes\/([^/]+)$/.exec(url.pathname);
        if (m && req.method === "GET") {
            const vm = vms.get(m[1]);
            if (!vm) return send(404, { error: "not_found" });
            vm.polls++;
            // 前两次轮询还在启动
            return send(200, { status: vm.polls < 2 ? "PROVISIONING" : "RUNNING", internalIp: vm.polls < 2 ? null : "127.0.0.1" });
        }
        if (m && req.method === "DELETE") {
            vms.delete(m[1]);
            return send(204);
        }
        send(404, { error: "not_found" });
    }).listen(0, "127.0.0.1");
    await new Promise((r) => brokerServer.once("listening", r));
    brokerUrl = `http://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;
});

after(async () => {
    for (const sb of sandboxes) await sb.stop().catch(() => undefined);
    brokerServer?.close();
    await daemon?.close();
    rmSync(dir, { recursive: true, force: true });
});

async function makeSandbox(chatId: string): Promise<Sandbox> {
    const sb = new Sandbox(undefined, chatId, {}, [], runtime());
    sb.setHostCallHandler(async (m) => (m === "mcp.list" ? [] : null));
    sandboxes.push(sb);
    await sb.start();
    return sb;
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
            setTimeout(tick, 50);
        };
        tick();
    });
}

describe("ephemeral sandbox VM per chat", () => {
    it("asks the broker for a VM, waits for it, runs code over plain TCP and deletes the VM on stop", async () => {
        brokerLog.length = 0;
        const sb = await makeSandbox("telegram:-111");
        const create = brokerLog.find((l) => l.method === "POST");
        assert.deepEqual(create?.body, { chatKey: create?.body.chatKey, region: "region-cheap1", machineType: "c4-standard-2" });
        assert.match(create!.body.chatKey, /^[a-f0-9]{32}$/);
        assert.equal(create?.auth, `Bearer id-token-for:${brokerUrl}`);
        assert.ok(brokerLog.filter((l) => l.method === "GET").length >= 2, "polled until RUNNING");

        const res = await sb.execute(`console.log(process.env.SANDBOX_NO_NETWORK, process.cwd().includes("homes"))`);
        assert.equal(res.output, "1 true");
        assert.equal(vms.size, 1);
        await sb.stop();
        await waitFor(() => vms.size === 0);
        assert.ok(brokerLog.some((l) => l.method === "DELETE"));
    });

    it("falls back to the next region on spot stockout", async () => {
        brokerLog.length = 0;
        exhaustedRegions = new Set(["region-cheap1"]);
        try {
            const sb = await makeSandbox("telegram:-222");
            const regions = brokerLog.filter((l) => l.method === "POST").map((l) => l.body.region);
            assert.deepEqual(regions, ["region-cheap1", "region-mid1"]);
            await sb.stop();
        } finally {
            exhaustedRegions = new Set();
        }
    });

    it("uses the agent's size hint for the next VM", async () => {
        brokerLog.length = 0;
        setSizeHint("telegram:-333", "large");
        try {
            const sb = await makeSandbox("telegram:-333");
            assert.equal(brokerLog.find((l) => l.method === "POST")?.body.machineType, "c4-standard-8");
            await sb.stop();
        } finally {
            clearSizeHints();
        }
    });

    it("deletes the VM when the session dies unexpectedly", async () => {
        const sb = await makeSandbox("telegram:-444");
        assert.equal(vms.size, 1);
        const exited = new Promise<void>((r) => sb.once("exit", () => r()));
        await sb.execute(`process.stdout.write("z".repeat(5 * 1024 * 1024))`, 30_000).catch(() => undefined);
        await exited;
        await waitFor(() => vms.size === 0);
    });

    it("sandboxd answers control requests over plain TCP", async () => {
        const health = await remoteControlRequest(
            { endpoints: [], connectTimeoutMs: 5_000 },
            { name: "local", address: `127.0.0.1:${sandboxdPort}` },
            { type: "health" },
        );
        assert.equal(health.type, "health_result");
    });

    it("cleans up the VM when the session cannot be established", async () => {
        const before = brokerLog.length;
        const sb = new Sandbox(undefined, "telegram:-555", {}, [], buildSandboxRuntime({
            mode: "remote", inheritHostEnv: false, skillsSyncBack: false,
            remote: {
                endpoints: [], connectTimeoutMs: 1_000, pingIntervalMs: 2_000,
                provisioner: {
                    brokerUrl, regions: ["region-cheap1"], sizes: { small: "c4-standard-2" }, defaultSize: "small",
                    port: 1, vmReadyTimeoutMs: 3_000, priceCacheFile: join(dir, "p2.json"),
                },
            },
        }, join(dir, "skills"), { broker: new BrokerClient(brokerUrl, async () => "t"), prices: null }));
        sb.setHostCallHandler(async () => []);
        await assert.rejects(sb.start());
        assert.ok(brokerLog.slice(before).some((l) => l.method === "DELETE"), "VM released after failed connect");
        assert.equal(vms.size, 0);
    });
});
