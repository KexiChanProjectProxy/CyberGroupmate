/**
 * process-exec-guard.ts — sandbox.process_exec=false 时在 worker 内封堵 OS 级执行
 *
 * Worker 里的 LLM 代码 / TS Skills 可以 `import("node:child_process")`、`require("child_process")`、
 * `process.getBuiltinModule(...)`、`process.binding("spawn_sync")` 等方式绕过 shell 模块直接起进程。
 * 这里在 worker 启动时（加载 Skills 之前）把这些入口全部替换成抛错。
 *
 * 这是 local 模式的 best-effort 防线；remote 模式本身是 gVisor + 无网络容器。
 * 已在 guard 之前静态 import 的 host 内部模块（例如 skill-loader 里的 spawn）不受影响，
 * 它们各自有 SANDBOX_NO_PROCESS_EXEC 检查。
 */

import Module, { register } from "node:module";

/** 能起进程 / 线程 / 加载原生代码的内置模块 */
export const BLOCKED_BUILTINS = ["child_process", "worker_threads", "cluster"] as const;

const BLOCKED = new Set<string>(BLOCKED_BUILTINS.flatMap((name) => [name, `node:${name}`]));

export function isBlockedBuiltin(specifier: string): boolean {
    return BLOCKED.has(specifier);
}

function blockedError(what: string): Error {
    return new Error(`[Sandbox 安全限制] ${what} 已禁用（sandbox.process_exec=false），sandbox 不能启动子进程`);
}

const RESOLVE_HOOK = `
const BLOCKED = new Set(${JSON.stringify([...BLOCKED])});
export async function resolve(specifier, context, next) {
    if (BLOCKED.has(specifier)) {
        throw new Error("[Sandbox 安全限制] " + specifier + " 已禁用（sandbox.process_exec=false），sandbox 不能启动子进程");
    }
    return next(specifier, context);
}
`;

let installed = false;

export function installProcessExecGuard(): void {
    if (installed) return;
    installed = true;

    // ESM: import / import()
    register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`);

    // CJS: require / createRequire
    const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
    const originalLoad = mod._load;
    mod._load = function guardedLoad(request: string, ...rest: unknown[]) {
        if (isBlockedBuiltin(request)) throw blockedError(request);
        return originalLoad.call(this, request, ...rest);
    };

    // process.getBuiltinModule (Node ≥22.3)
    const proc = process as unknown as Record<string, unknown>;
    const originalGetBuiltin = proc.getBuiltinModule as ((id: string) => unknown) | undefined;
    if (typeof originalGetBuiltin === "function") {
        Object.defineProperty(process, "getBuiltinModule", {
            value: (id: string) => {
                if (isBlockedBuiltin(id)) throw blockedError(id);
                return originalGetBuiltin.call(process, id);
            },
            writable: false,
            configurable: false,
        });
    }

    // 内部绑定 / 原生扩展
    for (const name of ["binding", "_linkedBinding", "dlopen"]) {
        Object.defineProperty(process, name, {
            value: () => { throw blockedError(`process.${name}`); },
            writable: false,
            configurable: false,
        });
    }
}
