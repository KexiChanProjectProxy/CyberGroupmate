/**
 * provisioner-broker.test.ts — Cloud Run broker：白名单、固定的 VM 安全参数、缺货回退、只能操作 sandbox VM
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AddressInfo } from "node:net";
import { BrokerError, createBrokerServer, loadBrokerConfigFromEnv, SandboxBroker, SANDBOX_NAME_PREFIX } from "../src/sandbox/provisioner/broker-server.js";
import { GceClient } from "../src/sandbox/provisioner/gce.js";

const CHAT = "0123456789abcdef0123456789abcdef";

interface FakeInstance { name: string; zone: string; status: string; labels: Record<string, string>; body: any; networkInterfaces: Array<{ networkIP: string }> }

/** 模拟 Compute REST API */
function fakeCompute(opts: { exhaustedZones?: string[] } = {}) {
    const instances = new Map<string, FakeInstance>();
    const calls: string[] = [];
    let ip = 10;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.pathname}${url.search}`);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        const p = url.pathname.replace(/^\/compute\/v1\/projects\/proj/, "");
        let m: RegExpExecArray | null;
        if ((m = /^\/zones\/([^/]+)\/instances$/.exec(p)) && method === "POST") {
            const body = JSON.parse(String(init!.body));
            const zone = m[1];
            if (opts.exhaustedZones?.includes(zone)) {
                instances.set(body.name, { name: body.name, zone, status: "TERMINATED", labels: body.labels, body, networkInterfaces: [] });
                return json(200, { name: "op1", status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no spot capacity" }] } });
            }
            instances.set(body.name, { name: body.name, zone, status: "RUNNING", labels: body.labels, body, networkInterfaces: [{ networkIP: `10.20.1.${ip++}` }] });
            return json(200, { name: "op2", status: "DONE" });
        }
        if ((m = /^\/zones\/([^/]+)\/instances\/([^/]+)$/.exec(p))) {
            const inst = instances.get(m[2]);
            if (!inst || inst.zone !== m[1]) return json(404, { error: { message: "not found", errors: [{ reason: "notFound" }] } });
            if (method === "DELETE") {
                instances.delete(m[2]);
                return json(200, { name: "op3", status: "RUNNING" });
            }
            return json(200, { name: inst.name, zone: `zones/${inst.zone}`, status: inst.status, labels: inst.labels, networkInterfaces: inst.networkInterfaces });
        }
        if (p === "/aggregated/instances") {
            const items: Record<string, { instances: unknown[] }> = {};
            for (const inst of instances.values()) {
                if (inst.labels?.["cgm-role"] !== "sandbox") continue;
                (items[`zones/${inst.zone}`] ??= { instances: [] }).instances.push({ name: inst.name, zone: `https://x/zones/${inst.zone}`, status: inst.status, labels: inst.labels });
            }
            return json(200, { items });
        }
        if (p === "/zones") return json(200, { items: [{ name: "r1-a", status: "UP", region: "regions/region-east1" }, { name: "r1-b", status: "UP", region: "regions/region-east1" }] });
        if ((m = /^\/zones\/([^/]+)\/machineTypes\/([^/]+)$/.exec(p))) return json(200, { name: m[2] });
        return json(404, { error: { message: `unexpected ${method} ${p}` } });
    };
    return { instances, calls, fetchImpl };
}

function makeBroker(opts: { exhaustedZones?: string[]; maxInstances?: number } = {}) {
    const compute = fakeCompute(opts);
    const cfg = loadBrokerConfigFromEnv({
        BROKER_SUBNETS: JSON.stringify({ "us-central1": "cgm-sandbox-us-central1", "europe-west9": "cgm-sandbox-europe-west9" }),
        BROKER_ZONES: JSON.stringify({ "us-central1": ["us-central1-a", "us-central1-b"] }),
        BROKER_MACHINE_TYPES: "c4-standard-2,c4-standard-8",
        BROKER_MAX_INSTANCES: String(opts.maxInstances ?? 5),
    }, "proj");
    const broker = new SandboxBroker(cfg, new GceClient("proj", async () => "tok", compute.fetchImpl));
    return { broker, compute };
}

describe("sandbox broker", () => {
    it("rejects non-C4 machine types in its own configuration", () => {
        assert.throws(() => loadBrokerConfigFromEnv({ BROKER_SUBNETS: '{"a-b1":"s"}', BROKER_MACHINE_TYPES: "n2-standard-2" }, "p"), /C4/);
        assert.throws(() => loadBrokerConfigFromEnv({}, "p"), /BROKER_SUBNETS/);
    });

    it("creates spot C4 VMs with fixed isolation settings", async () => {
        const { broker, compute } = makeBroker();
        const vm = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        assert.ok(vm.name.startsWith(SANDBOX_NAME_PREFIX));
        const body = compute.instances.get(vm.name)!.body;
        assert.equal(body.machineType, `zones/${vm.zone}/machineTypes/c4-standard-2`);
        assert.deepEqual(body.serviceAccounts, [], "no service account");
        assert.equal(body.networkInterfaces[0].accessConfigs, undefined, "no external IP");
        assert.match(body.networkInterfaces[0].subnetwork, /regions\/us-central1\/subnetworks\/cgm-sandbox-us-central1$/);
        assert.deepEqual(body.tags.items, ["cgm-sandbox"]);
        assert.equal(body.scheduling.provisioningModel, "SPOT");
        assert.equal(body.scheduling.instanceTerminationAction, "DELETE");
        assert.equal(body.scheduling.maxRunDuration.seconds, "86400");
        assert.equal(body.disks[0].initializeParams.diskType, `zones/${vm.zone}/diskTypes/hyperdisk-balanced`);
        assert.match(body.disks[0].initializeParams.sourceImage, /global\/images\/family\/cgm-sandbox-golden$/);
        assert.equal(body.shieldedInstanceConfig.enableSecureBoot, true);
        assert.equal(body.labels["cgm-role"], "sandbox");
        assert.equal(body.labels["cgm-chat"], CHAT);
    });

    it("validates every request field against its allowlists", async () => {
        const { broker, compute } = makeBroker();
        const bad: unknown[] = [
            { chatKey: CHAT, region: "us-central1", machineType: "n2-standard-2" },
            { chatKey: CHAT, region: "us-central1", machineType: "c4-standard-4" },
            { chatKey: CHAT, region: "asia-east1", machineType: "c4-standard-2" },
            { chatKey: "x", region: "us-central1", machineType: "c4-standard-2" },
            { chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2", serviceAccounts: [{ email: "owner@x" }] },
            { chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2", name: "prod-db" },
        ];
        for (const input of bad) {
            await assert.rejects(broker.create(input), (err: unknown) => err instanceof BrokerError && err.status >= 400 && err.status < 500, JSON.stringify(input));
        }
        assert.equal(compute.instances.size, 0);
    });

    it("falls back to the next zone on spot stockout and cleans up the failed instance", async () => {
        const { broker, compute } = makeBroker({ exhaustedZones: ["us-central1-a"] });
        const vm = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        assert.equal(vm.zone, "us-central1-b");
        assert.equal(compute.instances.size, 1, "half-created instance in the exhausted zone was deleted");
        const { broker: b2 } = makeBroker({ exhaustedZones: ["us-central1-a", "us-central1-b"] });
        await assert.rejects(b2.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" }), (e: unknown) => e instanceof BrokerError && e.code === "no_capacity");
    });

    it("enforces the instance cap", async () => {
        const { broker } = makeBroker({ maxInstances: 1 });
        await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        await assert.rejects(broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" }), (e: unknown) => e instanceof BrokerError && e.status === 429);
    });

    it("only reads and deletes labelled sandbox instances", async () => {
        const { broker, compute } = makeBroker();
        const vm = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        const st = await broker.get(vm.name, vm.zone);
        assert.equal(st.status, "RUNNING");
        assert.match(st.internalIp!, /^10\.20\.1\./);
        // 非 sandbox 名称 / 无 label 的实例一律拒绝
        await assert.rejects(broker.delete("prod-db", "us-central1-a"), (e: unknown) => e instanceof BrokerError && e.status === 400);
        compute.instances.set(`${SANDBOX_NAME_PREFIX}imposter`, { name: `${SANDBOX_NAME_PREFIX}imposter`, zone: "us-central1-a", status: "RUNNING", labels: {}, body: {}, networkInterfaces: [] });
        await assert.rejects(broker.delete(`${SANDBOX_NAME_PREFIX}imposter`, "us-central1-a"), (e: unknown) => e instanceof BrokerError && e.status === 403);
        assert.ok(compute.instances.has(`${SANDBOX_NAME_PREFIX}imposter`));
        await broker.delete(vm.name, vm.zone);
        assert.equal(compute.instances.has(vm.name), false);
        await broker.delete(vm.name, vm.zone); // 幂等
    });

    it("gc deletes old or terminated sandbox VMs", async () => {
        const { broker, compute } = makeBroker();
        const fresh = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        const old = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        compute.instances.get(old.name)!.labels["cgm-created"] = String(Math.floor(Date.now() / 1000) - 26 * 3600);
        const dead = await broker.create({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" });
        compute.instances.get(dead.name)!.status = "TERMINATED";
        const deleted = await broker.gc();
        assert.deepEqual(deleted.sort(), [old.name, dead.name].sort());
        assert.ok(compute.instances.has(fresh.name));
    });

    it("serves the HTTP API with proper status codes", async () => {
        const { broker } = makeBroker();
        const server = createBrokerServer(broker).listen(0, "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const created = await fetch(`${base}/v1/sandboxes`, { method: "POST", body: JSON.stringify({ chatKey: CHAT, region: "us-central1", machineType: "c4-standard-2" }) });
            assert.equal(created.status, 201);
            const vm = await created.json() as { name: string; zone: string };
            const got = await fetch(`${base}/v1/sandboxes/${vm.name}?zone=${vm.zone}`);
            assert.equal(got.status, 200);
            assert.equal((await fetch(`${base}/v1/sandboxes`, { method: "POST", body: "{bad" })).status, 400);
            assert.equal((await fetch(`${base}/v1/sandboxes`, { method: "POST", body: "x".repeat(20_000) })).status, 413);
            assert.equal((await fetch(`${base}/v1/sandboxes/${vm.name}?zone=${vm.zone}`, { method: "DELETE" })).status, 204);
            assert.equal((await fetch(`${base}/nope`)).status, 404);
        } finally {
            server.close();
        }
    });
});
