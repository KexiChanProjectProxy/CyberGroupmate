# 隔离 CodeAct Sandbox（remote 模式）

> 目标：按 **RCE 威胁模型** 规划——假设 agent 写的代码（及其 bash）完全受攻击者控制，
> 也不应造成实质安全问题：拿不到任何凭据、没有网络、不能影响其他聊天、不能拖垮宿主。

## 1. 架构

```
HOST VM（有受控出口：LLM / Telegram 白名单）            SANDBOX VM（零出口）
┌──────────────────────────────┐   mTLS / 每 session 一条连接   ┌──────────────────────────────────────┐
│ main.ts                      │ ─────────────────────────────▶ │ sandboxd（docker，runc，host 网络）  │
│  SandboxPool → Sandbox(客户端) │   10.10.0.3:7443               │  ├ 握手 / skills generation 存储     │
│   ├ 帧 schema 校验 / 限速 / 截断 │                                │  ├ homes/<sha256(chatId)>（持久）    │
│   ├ notify 过滤（防伪造消息）   │                                │  └ 每 session：docker run --runtime  │
│   └ host-call-handler         │                                │      runsc --network none …          │
│      ├ 按绑定 chatId 授权      │                                │      ┌───────────────────────────┐   │
│      ├ 路径守卫：sandbox 文件 → │                                │      │ supervisor（uid 1000）      │   │
│      │   inbox，宿主文件 → 拒绝  │                                │      │  ├ worker（agent JS/TS）    │   │
│      └ 平台 / memory / mcp …   │                                │      │  └ PTY bash tabs            │   │
└──────────────────────────────┘                                │      └───────────────────────────┘   │
                                                                └──────────────────────────────────────┘
```

- **host_call 是 sandbox 唯一的能力通道**，在 host 侧按 sandbox 绑定的 chatId 鉴权；sandbox 内没有任何凭据。
- **sandboxd 握手后只做字节转发**，不解析 session 方向的数据——被攻陷的 session 没有可攻击的解析代码。
- supervisor 与 worker 同 uid，**不是**信任边界；host 对其发出的一切按不可信数据处理。
- `sandbox.mode: local`（默认）保留单机开发体验：worker 与 PTY 仍在本机，但同样走帧协议、notify 过滤与环境变量白名单。

## 2. 威胁 → 缓解

| 攻击（sandbox 内 RCE） | 缓解 |
|---|---|
| 读取 bot token / API key / config.yaml / tg-session / memory.db | 独立 VM + 容器，不挂载任何宿主文件；env 只含白名单 + `scope: sandbox/both` 变量 |
| 访问网络、GCP metadata（窃取 SA token） | 容器 `--network none`（gVisor `--network=none`）；VM 无外网 IP、无 NAT、无 PGA、egress deny-all；VM 无服务账号；iptables 拒绝容器访问 169.254.169.254 |
| 让宿主读文件外发：`telegram.sendFile(chat, "memory.db")` | 路径守卫：参数中的宿主路径一律拒绝；sandbox 路径先拉取到 `workspace/.sandbox-inbox/`（host 决定文件名，50 MiB 上限） |
| 让宿主代为请求内网：`sendMedia({file: "http://169.254.169.254/…"})` | 路径守卫拒绝内网 / 元数据 / localhost URL；宿主出口另有白名单代理 |
| `mcp.connect({transport:"stdio", command:…})` 在宿主执行命令；或用 `${VAR}` 插值把宿主密钥发到任意 URL | sandbox 只能按名称连接 `config.yaml mcp_servers` 中的预配置服务器 |
| `runtime.env.set(..., "host")` 改写宿主 `NODE_OPTIONS` / `HTTPS_PROXY`；借受管 key 删除宿主 `PATH` / API key | 只能写 `scope: sandbox`；不能覆盖 host/both；不能创建与宿主现有 env 同名的 key；`env.list/get` 不返回 host 作用域 |
| 写 `workspace/skills/package.json` / `.npmrc`，等宿主 `npm install` 时执行 | 宿主在全新目录中只用 package.json + lockfile 安装，`--ignore-scripts`，最小 env；remote 模式下 sandbox 本就写不到宿主 skills |
| `runtime.notify({type:"nc.message", chatId:<任意群>, userId:<任意人>})` 伪造入站消息 / 写入记忆 | notify 过滤：保留类型改写为 `sandbox.notify`、chatId 固定为绑定 chat；`agent_message_sent` 必须对应 host 刚替该 sandbox 完成的真实发送 |
| 伪造 `extendSteps: 1e9` / 超长行 / 原型污染 / 洪泛 | 帧 zod 校验 + 钳制；单行 4 MiB；丢弃 `__proto__`/`constructor`/`prototype`；事件令牌桶；并发 host_call ≤ 8；违规直接终止 session |
| 读其他聊天的文件 / 进程 | 每 session 一个容器、每 chat 一个 home（0700）；容器间不共享 /proc、/tmp、网络命名空间 |
| fork bomb / 吃满内存 / 写满磁盘 | `--pids-limit` / `--memory`（无 swap）/ `--cpus`；ext4 project quota 限制每个 home；`/tmp` 为 512 MiB tmpfs |
| 内核 0-day 逃逸 | gVisor（runsc）作为用户态内核；即便逃逸到 VM：无凭据（仅 sandboxd 的服务端私钥）、无出口、无 SA |
| host 宕机后 session 残留 | host 每 15s ping，sandboxd 60s 无字节即回收；session 绝对寿命 48h；sandboxd 启动时清理孤儿容器 |

**残余风险**（设计上接受，需靠速率 / 审计约束）：
- sandbox 可以通过 host_call 对**绑定的聊天**做任何该聊天允许的事（发消息、建 cron、写 todo / memory、dispatch / elevate）。
  dispatch / elevate 是提示词注入通道：其它聊天的 agent 与 Meta agent 会读到 sandbox 产生的文本。
- `mcp.call` 调用的是管理员预配置的 MCP server，继承这些 server 自身的能力与信任。
- 同一 sandbox VM 上不同 session 之间的 CPU 侧信道。
- `skills_sync_back: true` 会让 agent 编写的 skill 文本进入宿主 `workspace/skills`（进而进入提示词与 harness 的读取范围），默认关闭。

## 3. 行为变化（remote 模式）

- 沙盒**没有网络**：`fetch` / `curl` / `pip` / `npm install` 失败；bashrc 中相关命令给出明确提示；`skills.npmInstall` 报错并引导管理员处理。
- 文件**按聊天隔离**：chat A 看不到 chat B 的文件。跨聊天协作走 `dispatch` / `memory`。
- 入站媒体：提示词中展示 workspace 相对路径（`Downloads/photos/…`），文件会被推送到该聊天 sandbox 的同一路径。
- 大文件 `downloadMedia`（>≈3 MB）由宿主直接写入 sandbox：返回 `{ path, savedToSandbox: true, buffer: "" }`。
- skills：宿主 `workspace/skills` 为唯一权威，按内容 generation 分发到 sandbox VM（只读）；sandbox 内修改只在本 session 生效。
  Dashboard「重载 skills」后新 session 使用新 generation。
- `ctx` / 后台持久任务保存在 sandbox home（`.sandbox-state/`）。

## 4. 部署（GCP）

前置：两台 VM 在同一子网——host VM（tag `cgm-host`，如 10.10.0.2）与 sandbox VM（tag `cgm-sandbox`，如 10.10.0.3）。

```bash
# 1) 网络与防火墙（sandbox egress deny-all、仅 host 可访问 7443/22）
REGION=asia-east1 scripts/sandbox-vm/gcp-network.sh

# 2) 镜像（CI 在 agentic 分支自动发布 :agentic-sandbox 与 :agentic-sandboxd）
docker build -f Dockerfile.sandbox --target session  -t ghcr.io/archeb/cybergroupmate:agentic-sandbox .
docker build -f Dockerfile.sandbox --target sandboxd -t ghcr.io/archeb/cybergroupmate:agentic-sandboxd .

# 3) golden image（临时 builder VM 安装 docker + gVisor + systemd 单元 + 镜像）
ZONE=asia-east1-b SESSION_IMAGE=… SANDBOXD_IMAGE=… scripts/sandbox-vm/build-image.sh

# 4) 创建 sandbox VM（无外网 IP、--no-service-account、Shielded VM、独立 homes PD）
ZONE=asia-east1-b IMAGE=cgm-sandbox-golden-<date> scripts/sandbox-vm/create-sandbox-vm.sh cgm-sandbox-1 10.10.0.3

# 5) 证书（在操作者本机生成；CA 私钥离线保存）
scripts/sandbox-vm/gen-certs.sh ./certs cgm-sandbox-1 10.10.0.3
scripts/sandbox-vm/install-certs.sh ./certs cgm-sandbox-1 asia-east1-b   # → sandbox VM /etc/cgm/tls + Secret Manager

# 6) sandbox VM 上：编辑 /etc/cgm/vm.env（HOST_VM_IP）与 /etc/cgm/sandboxd.yaml，然后
sudo systemctl restart cgm-iptables cgm-sandboxd

# 7) host VM：启动前取出客户端证书到 tmpfs，并配置 config.yaml
sudo scripts/sandbox-vm/fetch-host-certs.sh /run/cgm-tls
```

host `config.yaml`：

```yaml
sandbox:
  mode: remote
  remote:
    endpoints:
      - { name: cgm-sandbox-1, address: 10.10.0.3:7443, servername: cgm-sandbox-1 }
    tls: { ca: /run/cgm-tls/ca.crt, cert: /run/cgm-tls/client.crt, key: /run/cgm-tls/client.key }
```

- host 服务账号只需 `roles/secretmanager.secretAccessor`（仅限 `cgm-sandbox-*` 三个 secret）。
- 多台 sandbox VM：在 `endpoints` 中追加；chat 通过 rendezvous hashing 粘性分配（home 在对应 VM 上）。
- `sandboxd.max_sessions` 应 ≥ host `subagent.max_sandbox_instances`。

## 5. 运维

- **更新镜像**：在 host VM 上 `ZONE=… scripts/sandbox-vm/push-image.sh cgm-sandbox-1`（sandbox VM 不能 pull）。
- **更新 OS**：重建 golden image → 替换 VM（homes PD 卸载重挂，保持内网 IP）。sandbox VM 关闭了自动更新。
- **日志**：不安装 Cloud Logging agent（需要出口与 SA）。sandboxd 输出 JSON 到 docker 日志（轮转），
  并保留内存环形缓冲，host 可通过控制请求 `logs_tail` 拉取；break-glass 走 IAP SSH。
- **健康检查**：控制请求 `health` 返回 session 数、容量与 homes 剩余空间。
- **吊销 host 客户端证书**：从 `/etc/cgm/tls/allowed-clients` 删除指纹，`systemctl reload cgm-sandboxd`。
- **证书轮换**：先把新指纹加入 `allowed-clients`，再在 Secret Manager 中更新 host 证书并重启 host，最后删除旧指纹。
- **清理**：home 30 天未使用自动删除；skills 保留最近 3 个 generation；host inbox 文件 1 小时后清理。

## 6. 验收清单（以攻击者视角在 sandbox 中执行）

- `env`、`cat /proc/1/environ`：无任何凭据。
- `curl`、`python3 -c 'import urllib.request; urllib.request.urlopen("http://example.com")'`、`node -e 'fetch("http://169.254.169.254")'`：立即失败。
- `ls /home/agent/..`：看不到其他聊天的 home。
- `:(){ :|:& };:`：被 pids 上限止住，session 之外不受影响。
- `dd if=/dev/zero of=big bs=1M count=20000`：触发配额。
- `telegram.sendFile(chat, "/app/config.yaml")` / `sendFile(chat, "memory.db")`：报「不能引用宿主文件」。
- `mcp.connect({ name: "x", transport: "stdio", command: "sh" })`：被拒。
- `runtime.env.set("NODE_OPTIONS", "...", "host")`：被拒。
- `runtime.notify({ type: "nc.message", chatId: "<其他群>" })`：宿主收到的是 `sandbox.notify` 且 chatId 为绑定群。
- `process.stdout.write("x".repeat(5e6))`：session 被终止并在下次使用时重建。

自动化覆盖见 `tests/sandbox-remote.test.ts`、`tests/sandbox-hardening.test.ts`、`tests/host-call-security.test.ts`、
`tests/remote-file-guard.test.ts`、`tests/notify-guard.test.ts`、`tests/protocol-frames.test.ts`。
