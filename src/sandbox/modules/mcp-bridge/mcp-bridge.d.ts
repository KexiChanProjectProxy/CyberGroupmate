/**
 * mcp-bridge.d.ts — MCP Server 连接器类型定义
 *
 * 连接外部 MCP (Model Context Protocol) Server，自动发现并代理其工具。
 * 支持 stdio 和 Streamable HTTP 两种传输。
 */

declare const mcp: {
    /**
     * 按名称（重新）连接一个管理员在 config.yaml `mcp_servers` 中预配置的 MCP Server。
     * 连接参数（command / url / headers 等）一律取自宿主配置；sandbox 不能自定义服务器。
     * 连接在宿主进程中全局共享，所有 sandbox / subagent 可见。
     * 已连接的服务器无需再 connect，直接用 mcp.list() / mcp.call()。
     *
     * @param config - 预配置的服务器名，或 `{ name }`（其余字段会被忽略）
     * @returns 包含 tools 列表和 call 方法的代理对象
     *
     * @example
     * const github = await mcp.connect("github");
     * console.log("可用工具:", github.tools);
     *
     * // 调用 tool
     * const repos = await github.call("search_repositories", { query: "mcp typescript" });
     * console.log(repos);
     */
    connect(config: string | {
        /** 预配置的服务器名 */
        name: string;
    }): Promise<{
        name: string;
        tools: Array<{ name: string; description: string }>;
        /** 调用指定 tool */
        call(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
    }>;

    /**
        * 断开全局连接并清理 MCP Server 子进程
     * @param name 连接时指定的 name
     */
    disconnect(name: string): Promise<void>;

    /**
        * 列出所有全局已连接的 MCP Servers 及其工具
     *
     * @example
     * const servers = mcp.list();
     * for (const s of servers) {
     *   console.log(`${s.name}: ${s.tools.join(", ")} (running: ${s.running})`);
     * }
     */
    list(): Array<{
        name: string;
        description?: string;
        transport: "stdio" | "streamable-http";
        url?: string;
        tools: string[];
        running: boolean;
    }>;

    /**
     * 直接调用指定 server 的 tool（无需先调用 connect 返回的代理对象）
     * @param serverName MCP Server 名称
     * @param toolName 工具名称
     * @param args 工具参数
     */
    call(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
};
