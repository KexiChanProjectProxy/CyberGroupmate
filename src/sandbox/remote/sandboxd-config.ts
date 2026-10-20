/**
 * sandboxd-config.ts — sandboxd 自身的配置（独立于 host 的 config.yaml，不引入 src/core/config.ts）
 */

import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import { z } from "zod";

const sandboxdConfigSchema = z.object({
    listen: z.union([
        z.object({ host: z.string().default("0.0.0.0"), port: z.number().int().min(0).max(65535) }),
        z.object({ socket: z.string().min(1) }),
    ]),
    /**
     * mTLS（可选）。省略时为纯 TCP：仅适用于同一 GCP VPC 内网，
     * 访问控制由 VPC 防火墙（只放行 cgm-host tag）与 VM iptables 保证。
     */
    tls: z.object({
        ca: z.string().min(1),
        cert: z.string().min(1),
        key: z.string().min(1),
        /** 允许的客户端证书 SHA-256 指纹（hex，可带冒号）；为空则接受 CA 签发的任意客户端 */
        allowed_client_fingerprints: z.array(z.string()).default([]),
        /** 每行一个指纹的文件；SIGHUP 时重新读取 */
        allowed_clients_file: z.string().optional(),
    }).optional(),
    data_dir: z.string().min(1),
    launcher: z.enum(["process", "docker"]).default("docker"),
    docker: z.object({
        bin: z.string().default("docker"),
        image: z.string().default("ghcr.io/archeb/cybergroupmate:agentic-sandbox"),
        /** 容器 runtime（gVisor：runsc）；空字符串表示使用 dockerd 默认 */
        runtime: z.string().default("runsc"),
        user: z.string().regex(/^\d+:\d+$/).default("1000:1000"),
        /** "0" 表示不限制（以 VM 规格为界） */
        memory: z.coerce.string().default("2g"),
        cpus: z.coerce.string().default("2"),
        pids_limit: z.number().int().min(16).default(512),
        tmpfs_size: z.string().default("512m"),
        nofile: z.number().int().min(64).default(4096),
        extra_args: z.array(z.string()).default([]),
    }).default({}),
    /** home 目录属主（容器内 uid/gid；启用 userns-remap 时填映射后的 uid） */
    home_owner: z.object({ uid: z.number().int().min(0), gid: z.number().int().min(0) }).optional(),
    max_sessions: z.number().int().min(1).default(32),
    host_idle_kill_ms: z.number().int().min(5_000).default(60_000),
    session_max_lifetime_ms: z.number().int().min(60_000).default(48 * 3_600_000),
    home_ttl_days: z.number().min(1).default(30),
    keep_skill_generations: z.number().int().min(1).default(3),
    max_skills_bytes: z.number().int().min(1024).default(1024 * 1024 * 1024),
    handshake_timeout_ms: z.number().int().min(1_000).default(120_000),
});

export type SandboxdConfig = z.infer<typeof sandboxdConfigSchema>;

export function parseSandboxdConfig(raw: unknown): SandboxdConfig {
    return sandboxdConfigSchema.parse(raw);
}

export function loadSandboxdConfig(path: string): SandboxdConfig {
    const text = readFileSync(path, "utf-8");
    const raw = path.endsWith(".json") ? JSON.parse(text) : parseYAML(text);
    return parseSandboxdConfig(raw);
}

export function normalizeFingerprint(value: string): string {
    return value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

export function loadAllowedFingerprints(cfg: SandboxdConfig): Set<string> {
    if (!cfg.tls) return new Set();
    const set = new Set(cfg.tls.allowed_client_fingerprints.map(normalizeFingerprint).filter(Boolean));
    if (cfg.tls.allowed_clients_file) {
        for (const line of readFileSync(cfg.tls.allowed_clients_file, "utf-8").split(/\r?\n/)) {
            const fp = normalizeFingerprint(line.replace(/#.*/, ""));
            if (fp) set.add(fp);
        }
    }
    return set;
}
