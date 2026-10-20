#!/usr/bin/env bash
# create-daemon-vm.sh — 常驻 daemon VM（运行可信代码，具备公网访问）
#
# - 独立 VPC 中的 host 子网，固定内网 IP（sandbox golden image 的 iptables 只放行该 IP）
# - 专用服务账号（只有 broker 的 run.invoker；不授予任何 compute 权限）
# - tag cgm-host（可访问 sandbox 的 7443）+ cgm-admin（只允许 IAP SSH 入站）
#
# 用法：ZONE=us-west2-a scripts/sandbox-vm/create-daemon-vm.sh [<project>]
# 可选：NAME=cgm-daemon MACHINE=e2-medium SUBNET=cgm-subnet IP=10.10.0.2 DAEMON_SA_NAME=cgm-daemon DISK_GB=30
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:?ZONE is required}"
NAME="${NAME:-cgm-daemon}"
MACHINE="${MACHINE:-e2-medium}"
SUBNET="${SUBNET:-cgm-subnet}"
IP="${IP:-10.10.0.2}"
DAEMON_SA_NAME="${DAEMON_SA_NAME:-cgm-daemon}"
DAEMON_SA="${DAEMON_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

g() { gcloud --project "$PROJECT" "$@"; }

g iam service-accounts describe "$DAEMON_SA" >/dev/null 2>&1 || \
  g iam service-accounts create "$DAEMON_SA_NAME" --display-name "CyberGroupmate daemon VM"

g compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1 && { echo "$NAME exists"; exit 0; }

g compute instances create "$NAME" --zone "$ZONE" --machine-type "$MACHINE" \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size "${DISK_GB:-30}GB" --boot-disk-type pd-balanced \
  --network-interface "subnet=$SUBNET,private-network-ip=$IP,stack-type=IPV4_ONLY" \
  --tags cgm-host,cgm-admin \
  --service-account "$DAEMON_SA" --scopes cloud-platform \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE

echo "daemon VM: $NAME ($IP) sa=$DAEMON_SA"
