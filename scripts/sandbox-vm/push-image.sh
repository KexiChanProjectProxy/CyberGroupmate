#!/usr/bin/env bash
# push-image.sh — 在 host VM 上把新的 sandbox 镜像推到（无出口的）sandbox VM 并重启 sandboxd
#
# 用法：ZONE=asia-east1-b scripts/sandbox-vm/push-image.sh <sandbox-vm-name> [<session-image>] [<sandboxd-image>]
set -euo pipefail

NAME="${1:?sandbox vm name}"
ZONE="${ZONE:?ZONE is required}"
SESSION_IMAGE="${2:-ghcr.io/archeb/cybergroupmate:agentic-sandbox}"
SANDBOXD_IMAGE="${3:-ghcr.io/archeb/cybergroupmate:agentic-sandboxd}"

docker pull "$SESSION_IMAGE"
docker pull "$SANDBOXD_IMAGE"
docker save "$SESSION_IMAGE" "$SANDBOXD_IMAGE" | zstd -T0 -q | \
  gcloud compute ssh --zone "$ZONE" --internal-ip "$NAME" -- 'zstd -dc | sudo docker load && sudo systemctl restart cgm-sandboxd'
echo "pushed images to $NAME and restarted sandboxd"
