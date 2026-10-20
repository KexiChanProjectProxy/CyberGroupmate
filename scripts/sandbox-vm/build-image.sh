#!/usr/bin/env bash
# build-image.sh — 用临时 builder VM 制作 sandbox VM 的 golden image
#
# 用法：ZONE=asia-east1-b SESSION_IMAGE=ghcr.io/archeb/cybergroupmate:agentic-sandbox \
#       SANDBOXD_IMAGE=ghcr.io/archeb/cybergroupmate:agentic-sandboxd \
#       scripts/sandbox-vm/build-image.sh [<project>]
#
# builder VM 位于默认网络（有出口），不带 cgm-sandbox tag；完成后删除。
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:?ZONE is required}"
SESSION_IMAGE="${SESSION_IMAGE:?SESSION_IMAGE is required}"
SANDBOXD_IMAGE="${SANDBOXD_IMAGE:?SANDBOXD_IMAGE is required}"
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

docker pull "$SESSION_IMAGE"
docker pull "$SANDBOXD_IMAGE"
docker save "$SESSION_IMAGE" | zstd -T0 -q -o "$tmp/session.tar.zst"
docker save "$SANDBOXD_IMAGE" | zstd -T0 -q -o "$tmp/sandboxd.tar.zst"
tar -C "$REPO_ROOT" -czf "$tmp/repo.tgz" deploy/sandbox scripts/sandbox-vm docs/sandbox-remote.md

g compute instances create "$BUILDER" --zone "$ZONE" --machine-type e2-standard-2 \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 30GB \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
sleep 30
g compute scp --zone "$ZONE" "$tmp/session.tar.zst" "$tmp/sandboxd.tar.zst" "$tmp/repo.tgz" "$BUILDER:/tmp/"
g compute ssh --zone "$ZONE" "$BUILDER" -- \
  'sudo mkdir -p /opt/cgm && sudo tar -C /opt/cgm -xzf /tmp/repo.tgz && \
   sudo REPO_DIR=/opt/cgm bash /opt/cgm/scripts/sandbox-vm/setup-vm.sh /tmp/session.tar.zst /tmp/sandboxd.tar.zst && \
   sudo rm -f /tmp/*.tar.zst /tmp/repo.tgz'
g compute instances stop "$BUILDER" --zone "$ZONE"
g compute images create "cgm-sandbox-golden-$DATE" --source-disk "$BUILDER" --source-disk-zone "$ZONE" \
  --family cgm-sandbox-golden
echo "golden image: cgm-sandbox-golden-$DATE"
