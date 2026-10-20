#!/usr/bin/env bash
# build-image.sh — 用临时 builder VM 制作 sandbox VM 的 golden image
#
# 用法：ZONE=asia-east1-b SESSION_IMAGE=ghcr.io/archeb/cybergroupmate:agentic-sandbox \
#       SANDBOXD_IMAGE=ghcr.io/archeb/cybergroupmate:agentic-sandboxd \
#       scripts/sandbox-vm/build-image.sh [<project>]
#
# builder VM 位于默认网络（有出口），不带 cgm-sandbox tag；完成后删除。
#
# 可选：
#   BUILD_FROM_SOURCE=1  在 builder VM 上用当前仓库（git HEAD）构建两个镜像，无需本机 docker / 镜像仓库
#   SPOT=1               builder 使用 Spot VM
#   BUILDER_NETWORK=default
#   BUILDER_SUBNET=cgm-subnet BUILDER_TAGS=cgm-admin BUILDER_IAP=1
#                        把 builder 放进独立 VPC（需外网 IP 以安装软件包），经 IAP SSH 访问
#   EPHEMERAL=1          制作 broker 按需创建的临时 VM 镜像（纯 TCP、无 homes PD）；需同时给 HOST_VM_IP
#   IMAGE_FAMILY=cgm-sandbox-golden
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:?ZONE is required}"
BUILD_FROM_SOURCE="${BUILD_FROM_SOURCE:-0}"
if [ "$BUILD_FROM_SOURCE" != 1 ]; then
  SESSION_IMAGE="${SESSION_IMAGE:?SESSION_IMAGE is required}"
  SANDBOXD_IMAGE="${SANDBOXD_IMAGE:?SANDBOXD_IMAGE is required}"
fi
SPOT="${SPOT:-0}"
BUILDER_NETWORK="${BUILDER_NETWORK:-default}"
BUILDER="cgm-sandbox-builder-$(date +%s)"
DATE="$(date +%Y%m%d%H%M)"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

g() { gcloud --project "$PROJECT" "$@"; }
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
  g compute instances delete "$BUILDER" --zone "$ZONE" --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$BUILD_FROM_SOURCE" = 1 ]; then
  git -C "$REPO_ROOT" archive --format=tar.gz -o "$tmp/repo.tgz" HEAD
  uploads=("$tmp/repo.tgz")
  setup_args="--build"
else
  docker pull "$SESSION_IMAGE"
  docker pull "$SANDBOXD_IMAGE"
  docker save "$SESSION_IMAGE" | zstd -T0 -q -o "$tmp/session.tar.zst"
  docker save "$SANDBOXD_IMAGE" | zstd -T0 -q -o "$tmp/sandboxd.tar.zst"
  tar -C "$REPO_ROOT" -czf "$tmp/repo.tgz" deploy/sandbox scripts/sandbox-vm docs/sandbox-remote.md
  uploads=("$tmp/session.tar.zst" "$tmp/sandboxd.tar.zst" "$tmp/repo.tgz")
  setup_args="/tmp/session.tar.zst /tmp/sandboxd.tar.zst"
fi

builder_extra=()
[ "$SPOT" = 1 ] && builder_extra+=(--provisioning-model=SPOT --instance-termination-action=DELETE)
net_args=(--network "$BUILDER_NETWORK")
[ -n "${BUILDER_SUBNET:-}" ] && net_args=(--network "$BUILDER_NETWORK" --subnet "$BUILDER_SUBNET")
[ -n "${BUILDER_TAGS:-}" ] && net_args+=(--tags "$BUILDER_TAGS")
ssh_args=()
[ "${BUILDER_IAP:-0}" = 1 ] && ssh_args+=(--tunnel-through-iap)
g compute instances create "$BUILDER" --zone "$ZONE" --machine-type "${BUILDER_MACHINE:-e2-standard-4}" \
  "${net_args[@]}" \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 40GB \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring "${builder_extra[@]}"
for _ in $(seq 1 30); do
  g compute ssh --zone "$ZONE" "${ssh_args[@]}" "$BUILDER" --command true >/dev/null 2>&1 && break
  sleep 10
done
g compute scp --zone "$ZONE" "${ssh_args[@]}" "${uploads[@]}" "$BUILDER:/tmp/"
g compute ssh --zone "$ZONE" "${ssh_args[@]}" "$BUILDER" --command \
  "sudo mkdir -p /opt/cgm-src && sudo tar -C /opt/cgm-src -xzf /tmp/repo.tgz && \
   sudo REPO_DIR=/opt/cgm-src EPHEMERAL=${EPHEMERAL:-0} HOST_VM_IP=${HOST_VM_IP:-} bash /opt/cgm-src/scripts/sandbox-vm/setup-vm.sh $setup_args && \
   sudo rm -rf /tmp/*.tar.zst /tmp/repo.tgz /opt/cgm-src"
g compute instances stop "$BUILDER" --zone "$ZONE"
FAMILY="${IMAGE_FAMILY:-cgm-sandbox-golden}"
# GVNIC：C4 等新机型必需
g compute images create "$FAMILY-$DATE" --source-disk "$BUILDER" --source-disk-zone "$ZONE" \
  --family "$FAMILY" --guest-os-features=UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE
echo "golden image: $FAMILY-$DATE"
