/**
 * web — 联网搜索与网页抓取。
 *
 * 用于在派发任务前自己核实事实 / 查最新信息。抓取只允许公网 http/https 地址。
 * 普通的"帮群友查一下"仍应 dispatch 给对应群的子 agent（子 agent 也有同样的 web 模块）。
 */

/** 搜索引用来源 */
interface WebSearchSource {
    url: string;
    title?: string;
}

/** web.search 返回值 */
interface WebSearchResult {
    /** 带事实依据的回答 / 摘要 */
    answer: string;
    /** 引用来源（已去重） */
    sources: WebSearchSource[];
    /** 是否真的执行了联网搜索；false 时 answer 可能只是模型自身知识，不要当作最新事实 */
    searched: boolean;
}

/** web.fetch 的可选配置 */
interface WebFetchOptions {
    /** 返回格式：markdown（默认，保留链接）或 text（纯文本） */
    format?: "markdown" | "text";
    /** 正文最大字符数（默认由管理员配置，通常 20000） */
    maxChars?: number;
}

/** web.fetch 返回值 */
interface WebFetchResult {
    /** 请求的 URL */
    url: string;
    /** 跟随重定向后的最终 URL */
    finalUrl: string;
    /** HTTP 状态码 */
    status: number;
    /** 页面标题 */
    title?: string;
    /** 内容类型（如 text/html） */
    contentType: string;
    /** 正文（HTML 页面已抽取主体并转为 markdown / 纯文本） */
    content: string;
    /** 正文是否被截断 */
    truncated: boolean;
}

interface WebModule {
    /**
     * 联网搜索：用一句自然语言提问，返回带引用来源的回答。
     * 适合查最新消息、版本号、价格、事实核对等。问题写具体一些效果更好。
     *
     * @param query - 搜索问题（自然语言，建议带上关键实体和时间范围）
     * @returns 回答、来源列表、是否真的联网
     *
     * @example
     * const r = await web.search("Node.js 最新的 LTS 版本号是多少");
     * console.log(r.answer);
     * console.log(r.sources.map(s => s.url).join("\n"));
     */
    search(query: string): Promise<WebSearchResult>;

    /**
     * 抓取网页：下载 URL 并提取正文（HTML 自动去掉导航/脚本，转成 markdown）。
     * 只允许公网 http/https 地址；不支持图片、PDF 等二进制内容。
     *
     * @param url - 完整的 http(s) URL
     * @param options - 返回格式 / 最大字符数
     * @returns 页面标题、正文、是否截断
     *
     * @example
     * const page = await web.fetch("https://example.com/article");
     * console.log(page.title, page.truncated);
     * console.log(page.content.slice(0, 2000));
     *
     * @example
     * // 搜索后读第一个来源的原文
     * const r = await web.search("某开源项目 v2 发布说明");
     * if (r.sources[0]) console.log((await web.fetch(r.sources[0].url, { maxChars: 8000 })).content);
     */
    fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
}

declare const web: WebModule;
