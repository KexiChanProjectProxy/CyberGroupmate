/**
 * modules/web/index.ts — Web 模块（Worker 侧）
 *
 * web.search / web.fetch 都通过 callHost 在 Host 侧执行：
 * remote 沙盒没有网络，且代理 / API Key 只存在于 Host。
 */

export interface WebCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: WebCallbacks | null = null;

export function setWebCallbacks(callbacks: WebCallbacks): void {
    _callbacks = callbacks;
}

export const webModule = {
    search: async (query: string): Promise<unknown> => {
        if (!_callbacks) throw new Error("Web module not initialized");
        return _callbacks.callHost("web.search", [query]);
    },
    fetch: async (url: string, options?: { format?: "markdown" | "text"; maxChars?: number }): Promise<unknown> => {
        if (!_callbacks) throw new Error("Web module not initialized");
        return _callbacks.callHost("web.fetch", options ? [url, options] : [url]);
    },
};
