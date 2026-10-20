#!/usr/bin/env bash
# create-sandbox-vm.sh — 用 golden image 创建 sandbox VM（无外网 IP、无服务账号、Shielded VM）
#
# 用法：ZONE=asia-east1-b IMAGE=cgm-sandbox-golden-20261020 scripts/sandbox-vm/create-sandbox-vm.sh <name> <internal-ip> [<project>]
set -euo pipefail

NAME="${1:?vm name}"
IP="${2:?internal ip}"
PROJECT="${3:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:?ZONE is required}"
IMAGE="${IMAGE:?IMAGE (golden image name) is required}"
SUBNET="${SUBNET:-cgm-subnet}"
MACHINE="${MACHINE:-e2-standard-4}"
HOMES_SIZE="${HOMES_SIZE:-100GB}"

g() { gcloud --project "$PROJECT" "$@"; }

g compute disks describe "${NAME}-homes" --zone "$ZONE" >/dev/null 2>&1 || \
  g compute disks create "${NAME}-homes" --zone "$ZONE" --size "$HOMES_SIZE" --type pd-balanced

# --no-service-account --no-scopes：metadata server 不提供任何 token
# --no-address：无外网 IP；子网无 Cloud NAT / Private Google Access → 无出口
g compute instances create "$NAME" \
  --zone "$ZONE" --machine-type "$MACHINE" \
  --image "$IMAGE" --image-project "$PROJECT" \
  --boot-disk-size 30GB --boot-disk-type pd-balanced \
  --disk "name=${NAME}-homes,device-name=homes,mode=rw,auto-delete=no" \
  --network-interface "subnet=${SUBNET},private-network-ip=${IP},no-address,stack-type=IPV4_ONLY" \
  --tags cgm-sandbox \
  --no-service-account --no-scopes \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE,serial-port-enable=FALSE \
  --deletion-protection

echo "created $NAME ($IP). 下一步：scripts/sandbox-vm/install-certs.sh，然后在 VM 上写 /etc/cgm/vm.env 与 /etc/cgm/sandboxd.yaml"
