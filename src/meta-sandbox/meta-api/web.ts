import { loadConfig } from "../../core/config.js";
import { webFetch, type WebFetchOptions } from "../../core/web/fetch.js";
import { webSearch } from "../../core/web/search.js";

/** Meta 的 web API：与 sandbox `web` 模块同一实现（Meta 跑在 host 进程内，直接调用） */
export function createWebApi() {
    return {
        search: (query: string) => webSearch(loadConfig().web, String(query ?? "")),
        fetch: (url: string, options?: WebFetchOptions) => {
            const opts = options && typeof options === "object" ? options : {};
            return webFetch(loadConfig().web, String(url ?? ""), {
                ...(opts.format === "text" || opts.format === "markdown" ? { format: opts.format } : {}),
                ...(opts.maxChars != null ? { maxChars: Number(opts.maxChars) } : {}),
            });
        },
    };
}
