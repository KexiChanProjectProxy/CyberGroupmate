/**
 * sandbox-pool.test.ts — SandboxPool 与后台 shell.runBackground 监视器的生命周期交互
 *
 * 重点验证 P1：有后台命令在跑的 sandbox 不能被空闲回收（否则会静默 kill 进程且不发 shell_wake）。
 * 注意：本文件会启动真实 PTY worker，故被 run-tests 默认排除（文件名含 "sandbox"）。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { SandboxPool } from "../src/sandbox/sandbox-pool.js";

describe("SandboxPool × background shell.runBackground", () => {
    const pools: SandboxPool[] = [];

    function makePool(idleTimeout: number): SandboxPool {
        const pool = new SandboxPool({
            idleTimeout,
            onAcquire: (sb) => {
                sb.setHostCallHandler(async (method) => {
                    if (method === "mcp.list") return [];
                    throw new Error(`unexpected method: ${method}`);
                });
            },
        });
        pools.push(pool);
        return pool;
    }

    after(async () => {
        for (const p of pools) await p.dispose().catch(() => {});
    });

    it("does NOT reclaim an idle sandbox that has a running background command", async () => {
        const pool = makePool(1); // idleTimeout 1ms：除后台保护外，几乎立即可回收
        const sb = await pool.acquire("chatA");
        const { tabId } = await sb.runShellBackground("sleep 30", { idleTimeout: 0, maxDuration: 0 });
        pool.release("chatA"); // 模拟 CodeAct 一轮结束后 release

        assert.equal(sb.hasActiveBackgroundTasks(), true);
        await new Promise((r) => setTimeout(r, 10));

        // 触发空闲回收：尽管已 release 且超过 idleTimeout，后台命令在跑 → 必须跳过
        (pool as unknown as { cleanupIdle(): void }).cleanupIdle();
        assert.equal(pool.has("chatA"), true, "有后台命令时不应被回收");
        assert.equal(sb.isAlive(), true);

        // 后台命令结束（这里用 kill 模拟收尾）→ 不再有后台任务 → 可回收
        await sb.killShellTab(tabId);
        assert.equal(sb.hasActiveBackgroundTasks(), false);
        (pool as unknown as { cleanupIdle(): void }).cleanupIdle();
        assert.equal(pool.has("chatA"), false, "无后台命令后应被正常回收");
    });

    it("DOES reclaim an idle sandbox with no background command (control)", async () => {
        const pool = makePool(1);
        const sb = await pool.acquire("chatB");
        await sb.executeShell('echo hi'); // 前台命令，完成后无 monitor
        pool.release("chatB");

        assert.equal(sb.hasActiveBackgroundTasks(), false);
        await new Promise((r) => setTimeout(r, 10));
        (pool as unknown as { cleanupIdle(): void }).cleanupIdle();
        assert.equal(pool.has("chatB"), false, "无后台命令的空闲实例应被回收");
    });

    it("a completed background command clears the active flag and emits shell_wake exit", async () => {
        const pool = makePool(600000);
        const sb = await pool.acquire("chatC");
        const wake = new Promise<{ reason: string; tabId: string }>((resolve) =>
            sb.once("shell_wake", resolve as (e: unknown) => void));
        const { tabId } = await sb.runShellBackground("sleep 1; echo POOL_DONE", { idleTimeout: 0 });
        assert.equal(sb.hasActiveBackgroundTasks(), true);

        const ev = await wake;
        assert.equal(ev.reason, "exit");
        assert.equal(ev.tabId, tabId);
        // 完成后 monitor 清空 → 实例不再被保护
        assert.equal(sb.hasActiveBackgroundTasks(), false);
    });
});

describe("SandboxPool idle cleanup timing", () => {
    it("reclaims an idle instance within ~30s of the idle timeout, not idleTimeout/2 later", async () => {
        const { mock } = await import("node:test");
        mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
        try {
            const pool = new SandboxPool({ maxInstances: 2, idleTimeout: 600_000 });
            let stopped = false;
            const fake = { stop: async () => { stopped = true; }, isAlive: () => true, hasActiveBackgroundTasks: () => false };
            (pool as unknown as { pool: Map<string, unknown> }).pool.set("c", { sandbox: fake, chatId: "c", inUse: false, lastUsedAt: 0, skillGeneration: 0 });
            mock.timers.tick(600_000);
            assert.equal(stopped, false);
            mock.timers.tick(30_000);
            assert.equal(stopped, true, "reclaimed within 30s after the 10-minute idle timeout");
            await pool.dispose();
        } finally {
            mock.timers.reset();
        }
    });
});
