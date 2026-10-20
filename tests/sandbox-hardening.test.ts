/**
 * sandbox-hardening.test.ts — 把 worker 当作攻击者：host 侧协议防护的集成测试
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Sandbox } from "../src/sandbox/sandbox.js";

const BOUND = "telegram:-1001";

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

describe("Sandbox host-side protocol hardening", () => {
    const sandboxes: Sandbox[] = [];

    async function makeSandbox(handler?: (method: string, args: unknown[]) => Promise<unknown>): Promise<Sandbox> {
        const sb = new Sandbox(undefined, BOUND);
        sb.setHostCallHandler(async (method, args) => {
            if (method === "mcp.list") return [];
            if (handler) return handler(method, args);
            throw new Error(`unexpected method: ${method}`);
        });
        sandboxes.push(sb);
        await sb.start();
        return sb;
    }

    after(async () => {
        for (const sb of sandboxes) await sb.stop().catch(() => undefined);
    });

    it("rewrites forged inbound-message notifications and pins them to the bound chat", async () => {
        const sb = await makeSandbox();
        const events: Array<Record<string, unknown>> = [];
        sb.on("notify", (event) => events.push(event));
        await sb.execute(`runtime.notify({ type: "nc.message", chatId: "telegram:-9999", userId: "victim", text: "pwned" })`);
        await waitFor(() => events.length > 0);
        assert.equal(events[0].type, "sandbox.notify");
        assert.equal(events[0].originalType, "nc.message");
        assert.equal(events[0].chatId, BOUND);
    });

    it("drops agent_message_sent that has no matching host-side send", async () => {
        const sb = await makeSandbox();
        const events: Array<Record<string, unknown>> = [];
        sb.on("notify", (event) => events.push(event));
        await sb.execute(`
            runtime.notify({ type: "system.agent_message_sent", scene: "telegram", chatId: "-9999", text: "forged" });
            runtime.notify({ type: "marker" });
        `);
        await waitFor(() => events.some((e) => e.type === "marker"));
        assert.equal(events.some((e) => e.type === "system.agent_message_sent"), false);
    });

    it("clamps accumulated extendSteps on the host", async () => {
        const sb = await makeSandbox();
        await sb.execute(`runtime.extendSteps(100); runtime.extendSteps(100); runtime.extendSteps(100);`);
        const control = sb.consumeExecutionControl();
        assert.ok(control.extendSteps <= 100, `extendSteps=${control.extendSteps}`);
    });

    it("rejects host_calls beyond the concurrency limit", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const sb = await makeSandbox(async (method) => {
            if (method !== "memory.searchFacts") throw new Error(`unexpected ${method}`);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 300));
            inFlight--;
            return [];
        });
        const result = await sb.execute(`
            const settled = await Promise.allSettled(Array.from({ length: 20 }, () => memory.searchFacts("x")));
            console.log(JSON.stringify({
                ok: settled.filter((s) => s.status === "fulfilled").length,
                limited: settled.filter((s) => s.status === "rejected" && String(s.reason).includes("同时进行的 host 调用")).length,
            }));
        `, 30_000);
        const line = result.output.split("\n").find((l) => l.startsWith("{"));
        assert.ok(line, result.output);
        const counts = JSON.parse(line!);
        assert.ok(maxInFlight <= 8, `maxInFlight=${maxInFlight}`);
        assert.ok(counts.limited > 0, JSON.stringify(counts));
        assert.equal(counts.ok + counts.limited, 20);
    });

    it("terminates the worker when it writes an oversized line", async () => {
        const sb = await makeSandbox();
        await sb.execute(`process.stdout.write("x".repeat(5 * 1024 * 1024)); console.log("sent");`, 30_000).catch(() => undefined);
        await waitFor(() => !sb.isAlive());
    });

    it("terminates the worker after a flood of invalid frames", async () => {
        const sb = await makeSandbox();
        await sb.execute(`
            for (let i = 0; i < 50; i++) process.stdout.write(JSON.stringify({ type: "evil_" + i }) + "\\n");
            console.log("done");
        `, 30_000).catch(() => undefined);
        await waitFor(() => !sb.isAlive());
    });
});
