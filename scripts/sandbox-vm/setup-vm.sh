#!/usr/bin/env bash
# setup-vm.sh — 在 golden image 的 builder VM（有网络）上运行，安装 sandbox VM 所需的一切
#
# 安装：docker-ce、gVisor runsc、daemon.json、systemd 单元、脚本、sysctl；homes PD 首次启动时格式化。
# 之后由 build-image.sh 制作 golden image —— 生产 sandbox VM 无出口，不能在运行时 apt / docker pull。
#
# 用法（在 builder VM 上，以 root）：
#   REPO_DIR=/opt/cgm ./setup-vm.sh <sandbox-image.tar.zst> <sandboxd-image.tar.zst>
#   REPO_DIR=/opt/cgm ./setup-vm.sh --build      # 从 REPO_DIR 中的完整源码构建镜像
#
# EPHEMERAL=1：用于 broker 按需创建的临时 Spot VM——sandboxd 以 VPC 内纯 TCP 监听、home 在启动盘
#              （无 homes PD），HOST_VM_IP 为 daemon VM 内网 IP（写入 /etc/cgm/vm.env）
set -euo pipefail
EPHEMERAL="${EPHEMERAL:-0}"

SESSION_TAR="${1:?session image tarball or --build}"
SANDBOXD_TAR="${2:-}"
REPO_DIR="${REPO_DIR:-/opt/cgm}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg zstd quota e2fsprogs iptables

# Docker CE
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
# gVisor
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /etc/apt/keyrings/gvisor.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gvisor.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list
apt-get update
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io runsc

install -m 0644 "$REPO_DIR/deploy/sandbox/daemon.json" /etc/docker/daemon.json
systemctl restart docker
docker info --format '{{json .Runtimes}}' | grep -q runsc

if [ "$SESSION_TAR" = "--build" ]; then
  docker build -f "$REPO_DIR/Dockerfile.sandbox" --target session -t ghcr.io/archeb/cybergroupmate:agentic-sandbox "$REPO_DIR"
  docker build -f "$REPO_DIR/Dockerfile.sandbox" --target sandboxd -t ghcr.io/archeb/cybergroupmate:agentic-sandboxd "$REPO_DIR"
  docker builder prune -af >/dev/null 2>&1 || true
else
  zstd -dc "$SESSION_TAR" | docker load
  zstd -dc "${SANDBOXD_TAR:?sandboxd image tarball}" | docker load
fi

# systemd 单元 + 脚本
install -d -m 0755 /opt/cgm/scripts/sandbox-vm /opt/cgm/docs /etc/cgm
if [ "$(realpath "$REPO_DIR/scripts/sandbox-vm")" != "$(realpath /opt/cgm/scripts/sandbox-vm)" ]; then
  install -m 0755 "$REPO_DIR"/scripts/sandbox-vm/*.sh /opt/cgm/scripts/sandbox-vm/
  install -m 0644 "$REPO_DIR/docs/sandbox-remote.md" /opt/cgm/docs/ 2>/dev/null || true
fi
chmod 0755 /opt/cgm/scripts/sandbox-vm/*.sh
install -m 0644 "$REPO_DIR"/deploy/sandbox/systemd/*.service "$REPO_DIR"/deploy/sandbox/systemd/*.timer /etc/systemd/system/
install -m 0644 "$REPO_DIR/deploy/sandbox/vm.env.example" /etc/cgm/vm.env
[ -n "${HOST_VM_IP:-}" ] && sed -i "s/^HOST_VM_IP=.*/HOST_VM_IP=${HOST_VM_IP}/" /etc/cgm/vm.env
if [ "$EPHEMERAL" = 1 ]; then
  install -m 0644 "$REPO_DIR/deploy/sandbox/sandboxd.ephemeral.yaml" /etc/cgm/sandboxd.yaml
  install -d -m 0711 /var/lib/cgm
else
  install -m 0644 "$REPO_DIR/deploy/sandbox/sandboxd.example.yaml" /etc/cgm/sandboxd.yaml
fi

# homes PD：首次启动时格式化（ext4 + project quota），挂载到 /var/lib/cgm
cat > /etc/systemd/system/var-lib-cgm.mount <<'EOF'
[Unit]
Description=CyberGroupmate sandbox homes disk
Requires=cgm-format-homes.service
After=cgm-format-homes.service

[Mount]
What=/dev/disk/by-id/google-homes
Where=/var/lib/cgm
Type=ext4
Options=prjquota,nosuid,nodev,noatime

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/cgm-format-homes.service <<'EOF'
[Unit]
Description=Format sandbox homes disk on first boot
ConditionPathExists=/dev/disk/by-id/google-homes
Before=var-lib-cgm.mount

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'blkid /dev/disk/by-id/google-homes || mkfs.ext4 -F -O quota,project -L cgm-homes /dev/disk/by-id/google-homes'
EOF

# 内核加固
cat > /etc/sysctl.d/90-cgm-sandbox.conf <<'EOF'
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
kernel.unprivileged_userns_clone = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
EOF

# 无出口 VM 上的自动更新只会失败：关闭，改为定期重建 golden image
systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

systemctl daemon-reload
if [ "$EPHEMERAL" = 1 ]; then
  rm -f /etc/systemd/system/var-lib-cgm.mount /etc/systemd/system/cgm-format-homes.service
  systemctl daemon-reload
  systemctl enable cgm-iptables.service cgm-sandboxd.service
else
  systemctl enable var-lib-cgm.mount cgm-iptables.service cgm-homes-quota.timer cgm-sandboxd.service
fi
echo "setup complete — 请编辑 /etc/cgm/vm.env 与 /etc/cgm/sandboxd.yaml，然后用 build-image.sh 制作镜像"
