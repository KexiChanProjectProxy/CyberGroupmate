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
| fork bomb / 吃满内存 / 写满磁盘 | `--pids-limit` / `--memory`（无 swap）/ `--cpus`；ext4 project quota 限制每个 home；`/tmp` 为 512 MiB tmpfs。fork bomb 会耗尽**本 session** 的 pids 上限导致该容器退出（host 视为会话结束，下次使用时重建），其他 session 与 sandboxd 不受影响 |
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

自动化验收脚本（在 host VM 上运行，覆盖下列全部条目，并验证 fork 炸弹隔离、跨会话隔离与会话回收）：

```bash
SANDBOX_ENDPOINT=10.10.0.3:7443 SANDBOX_SERVERNAME=cgm-sandbox-1 SANDBOX_TLS_DIR=/run/cgm-tls \
QUOTA_MIB=5120 npx tsx scripts/sandbox-vm/acceptance.ts
```

> 已在真实环境验证（2026-10-20，arm64 Armbian + docker 29 + gVisor release-20261012，按本文 systemd / iptables /
> project quota 部署，host 经 mTLS 跨机连接）：21/21 通过。注意 gVisor 下配额耗尽时 `dd` 不一定打印
> `Disk quota exceeded`，以实际写入大小为准。新版 gVisor 手动安装时需把发布包中的 `gvisor-bin/` 放在 `runsc` 同目录（apt 包会自动处理）。

手动检查项：

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

## 7. 临时 VM 模式（推荐）：每个 chat 一台 C4 Spot VM

```
daemon VM（可信代码 + 公网）          Cloud Run: cgm-sandbox-broker           按需 Spot VM（最便宜 region）
┌──────────────────────────┐  ID token  ┌──────────────────────────────┐  compute ┌───────────────────────────┐
│ main.ts                  │ ─────────▶ │ 唯一持有 VM 创建/删除权限      │ ───────▶ │ cgm-sbx-xxxx (C4, Spot)   │
│  每日 Billing Catalog 价格 │  run.invoker│ 白名单：C4 机型 / 已建子网 region│          │ 无 SA、无外网 IP、gVNIC     │
│  → 本地排序 → 请求开机      │            │ 固定：镜像 / tag / Spot /      │          │ sandboxd + gVisor session │
│  会话结束 → 请求删除        │            │ Shielded / maxRunDuration      │          │ home 随 VM 删除            │
└──────────┬───────────────┘            └──────────────────────────────┘          └─────────────▲─────────────┘
           └──────────────── 全局 VPC 内网，纯 TCP 7443（防火墙只放行 cgm-host tag）─────────────────┘
```

- **权限隔离**：daemon 服务账号只有 broker 的 `roles/run.invoker`，没有任何 compute 权限。
  即使 daemon 被攻陷，也只能经 broker 在白名单内开关 sandbox VM；broker 只读写带 `cgm-role=sandbox` label、名称为 `cgm-sbx-*` 的实例。
- **价格**：daemon 每天通过 Cloud Billing Catalog API 拉取一次 Compute SKU，计算 `Spot Preemptible C4 Instance Core/Ram` 在各候选 region 的小时价并排序；
  创建时按价格从低到高请求 broker，broker 在 region 内按 zone 回退（Spot 缺货）。
- **规格**：默认 `small`（c4-standard-2）；agent 可调用 `runtime.sandboxSize("large")` 提示下一台 VM 的规格（当前 VM 不替换）。
- **生命周期**：VM 随 sandbox 会话（空闲超时 / LRU / 错误）释放即删除；VM 自带 `maxRunDuration` 到期自动删除；broker `/v1/gc` 可由 Cloud Scheduler 定期清理。
- **网络**：同一 VPC 内网纯 TCP（无 mTLS）。sandbox 子网无 NAT / PGA，egress deny-all，ingress 只放行 `cgm-host`。

部署：

```bash
# 1) 独立 VPC（无 peering / VPN）：host 子网 + 每个候选 region 一个 sandbox 子网（cgm-sandbox-<region>）
REGION=us-west2 SANDBOX_REGIONS="northamerica-northeast1 europe-west9 asia-southeast2 us-central1" \
scripts/sandbox-vm/gcp-network.sh

# 2) 常驻 daemon VM（e2-medium，固定内网 IP 10.10.0.2，专用服务账号 cgm-daemon，IAP-only SSH）
ZONE=us-west2-a scripts/sandbox-vm/create-daemon-vm.sh

# 3) 临时 VM 镜像（builder 位于独立 VPC 内，经 IAP；HOST_VM_IP = daemon VM 内网 IP）
ZONE=us-west2-a SPOT=1 BUILD_FROM_SOURCE=1 EPHEMERAL=1 HOST_VM_IP=10.10.0.2 IMAGE_FAMILY=cgm-sandbox-ephemeral \
BUILDER_NETWORK=cgm-vpc BUILDER_SUBNET=cgm-subnet BUILDER_TAGS=cgm-admin BUILDER_IAP=1 \
scripts/sandbox-vm/build-image.sh

# 4) Spot VM instance template（C4 / Spot / 无 SA / 无外网 IP / gVNIC / Hyperdisk / maxRunDuration）
SUBNET_REGION=northamerica-northeast1 scripts/sandbox-vm/create-spot-template.sh

# 5) broker（Cloud Run）；基于 instance template 开机；DAEMON_SA 只获得 run.invoker
REGION=us-west2 DAEMON_SA=cgm-daemon@PROJECT.iam.gserviceaccount.com \
SANDBOX_REGIONS="northamerica-northeast1 europe-west9 asia-southeast2 us-central1" \
INSTANCE_TEMPLATE=cgm-sandbox-c4-spot GC_SCHEDULE="17 * * * *" \
scripts/sandbox-vm/deploy-broker.sh

# 6) daemon config.yaml：sandbox.remote.provisioner（见 config.example.yaml）

# 7) 验收（在 daemon VM 上）
BROKER_URL=https://cgm-sandbox-broker-xxxx.run.app SANDBOX_REGIONS="northamerica-northeast1 europe-west9 us-central1" \
npx tsx scripts/sandbox-vm/acceptance.ts
```

注意：
- C4 只支持 Hyperdisk 与 gVNIC；`build-image.sh` 会为镜像声明 `GVNIC`。
- Cloud Run 前端保留以 `z` 结尾的路径（如 `/healthz`），broker 健康检查为 `/v1/health`。
- 冷启动（创建 VM → sandboxd 就绪）约 1–2 分钟，`vm_ready_timeout_ms` 默认 5 分钟。
- broker 服务账号的 `roles/compute.instanceAdmin.v1` 带 IAM Condition，只作用于名称为 `cgm-sbx-*` 的实例与磁盘
  （`deploy-broker.sh` 自动设置）。已在共享项目中实测：可以创建 / 删除 `cgm-sbx-*`，
  创建其他名称的 VM、停止或删除项目中其他 VM 均被拒绝。若希望连只读权限也隔离，可把 sandbox 放进独立项目。

### 当前部署（2026-10-20，项目 PROJECT）

| 组件 | 资源 |
|---|---|
| VPC | `cgm-vpc`（独立，无 peering / VPN / Cloud NAT）；`cgm-subnet` 10.10.0.0/24（us-west2）；`cgm-sandbox-{northamerica-northeast1,europe-west9,asia-southeast2,us-central1}` 10.20.1–4.0/24 |
| daemon VM | `cgm-daemon`，e2-medium，us-west2-a，10.10.0.2，SA `cgm-daemon@`（仅 broker 的 run.invoker） |
| 镜像 / 模板 | image family `cgm-sandbox-ephemeral`；instance template `cgm-sandbox-c4-spot` |
| broker | Cloud Run `cgm-sandbox-broker`（us-west2），SA `cgm-sandbox-broker@`（`compute.instanceAdmin.v1` + 条件 `cgm-sandbox-vms-only`）；Cloud Scheduler `cgm-sandbox-broker-gc` 每小时 |

验收（daemon VM 上运行 `acceptance.ts`，BROKER_URL 模式）：19/19；VM 按当日价格开在 northamerica-northeast1，会话结束后全部删除。

### 访问其他 VPC 中的单个服务（仅 daemon）

daemon 需要访问 default 网络中的 LLM 网关 `10.128.0.10:23000`（`llm-gateway-vm`）：

```bash
TARGET_IP=10.128.0.10 PEER_NETWORK=default PEER_RANGE=10.128.0.0/9 \
DAEMON_SA=cgm-daemon@PROJECT.iam.gserviceaccount.com scripts/sandbox-vm/peer-target.sh
```

- 已验证：daemon → 10.128.0.10:23000 可达；daemon → default 网络其他 VM 被拒；sandbox VM（即使清空自身 iptables）
  → 10.128.0.10 / default 网络 / daemon / 公网均被拒；default 网络 → daemon / sandbox VM 均被拒。
- 目标 VM 的主机防火墙为 nftables（默认 drop），已追加 `ip saddr 10.10.0.2 tcp dport 23000 accept`
  （实时规则 + `/etc/nftables.conf`，原文件备份为 `/etc/nftables.conf.bak-cgm-20261020144050`）。

### daemon 运行状态

`cybergroupmate.service`（systemd，开机自启，`deploy/daemon/cybergroupmate.service` 为模板）；
Telegram `bot_api`（@your_bot）；LLM 为 Anthropic Messages 协议，经内网网关；Dashboard / MCP 仅监听 127.0.0.1
（经 `gcloud compute ssh cgm-daemon --tunnel-through-iap -- -L 6767:127.0.0.1:6767` 访问）。

### Dashboard 公网访问（Cloudflare Tunnel + Access）

- `cloudflared-cgm.service`（`deploy/daemon/cloudflared-cgm.service`）运行远程托管 tunnel `cgm-daemon-dashboard`，
  ingress 只有 `dashboard.example.com → http://127.0.0.1:6767`，其余 404；Dashboard 仍只监听 127.0.0.1。
- Access 应用 `cgm-dashboard`（self-hosted，24h 会话）+ 策略 `cgm-dashboard-owner`（仅允许指定邮箱）；
  先建 Access 应用再建 DNS 记录，未登录访问页面 / API / WebSocket 均 302 到 Access 登录页。
- Dashboard 自身的随机 token 保留为第二道认证（`~/cgm/config.yaml` 的 `dashboard.token`）。
