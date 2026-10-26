/**
 * shared/skills.d.ts — Skills 高层能力 + 管理接口
 */

interface SkillListEntry {
    /** workspace/skills 下的真实目录名。读写文件请使用 path/id，不要猜 bindingName。 */
    id: string;
    /** SKILL.md frontmatter name 或目录名，用于展示。 */
    name: string;
    /** Sandbox 中注入的 JS 变量名，例如 find_ero。调用 Skill API 用它。 */
    bindingName: string;
    /** Agent 在 sandbox fs 中访问该 skill 的相对路径，例如 skills/find-ero。 */
    path: string;
    /** Skill 类型：agent 为 SKILL.md-only，code 为 index.ts/js 代码型。 */
    kind: "agent" | "code";
    /** 是否存在 SKILL.md 指南。 */
    hasSkillMd: boolean;
    /** 是否存在 .d.ts 类型声明。 */
    hasDts: boolean;
}

declare const skills: {
    /**
     * 安装或创建一个新 Skill。支持SKILL.md 型（多数场景）和TS Skills（复杂能力场景）
     * 两种方式完成文件后，都需要调用 skills.reload() 生效。
     * @param name 拟创建的 Skill 名称
     * @returns 按规范创建 skill 的操作说明文档
     */
    install(name: string): string;

    /**
     * 列出当前已加载的 Skills 元数据。
     * `bindingName` 用于调用注入的全局变量，`path` 用于通过 fs 读取该 skill 的文件。
     * @returns 如 [{ id: "find-ero", name: "find-ero", bindingName: "find_ero", path: "skills/find-ero", kind: "agent", hasSkillMd: true, hasDts: false }]
     */
    list(): SkillListEntry[];

    /**
     * 热重载所有 Skills。在 workspace/skills/ 下创建/修改文件后调用。
     * @returns 重载后的 Skills 元数据列表
     * 
     * @example
     * // 创建 Skill 后重载
     * fs.writeFile("skills/myapi/index.ts", code);
     * fs.writeFile("skills/myapi/myapi.d.ts", typeDefs);
     * const loaded = await skills.reload();
     * console.log("已加载:", loaded.map(skill => `${skill.bindingName} -> ${skill.path}`));
     */
    reload(): Promise<SkillListEntry[]>;

    /**
     * 安装 npm 包到 workspace/skills/ 目录。
     * 管理员关闭 OS 级执行（sandbox.process_exec=false）或沙盒无网络时会抛错，
     * 此时需请管理员把依赖加入 workspace/skills/package.json。
     * @param packages 包名列表，如 ["axios", "cheerio@1.0.0"]
     * @returns 安装输出
     * 
     * @example
     * await skills.npmInstall(["cheerio", "node-fetch"]);
     */
    npmInstall(packages: string[]): Promise<string>;
};
