#!/usr/bin/env bash
# create-spot-template.sh — 创建 sandbox Spot VM 的 instance template（broker 基于它开机）
#
# 模板固定：C4、Spot（终止即删除）、maxRunDuration、无服务账号、无外网 IP、gVNIC、Hyperdisk、
# Shielded VM、OS Login、tag cgm-sandbox。broker 创建时只覆盖名称 / 机型 / 子网 / label，
# 并再次强制无 SA、无外网 IP、Spot 等安全字段。
#
# 用法：SUBNET_REGION=northamerica-northeast1 scripts/sandbox-vm/create-spot-template.sh [<project>]
# 可选：TEMPLATE=cgm-sandbox-c4-spot IMAGE_FAMILY=cgm-sandbox-ephemeral MACHINE=c4-standard-2
#       DISK_GB=40 MAX_RUN=24h NETWORK=cgm-vpc
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
TEMPLATE="${TEMPLATE:-cgm-sandbox-c4-spot}"
IMAGE_FAMILY="${IMAGE_FAMILY:-cgm-sandbox-ephemeral}"
MACHINE="${MACHINE:-c4-standard-2}"
DISK_GB="${DISK_GB:-40}"
MAX_RUN="${MAX_RUN:-24h}"
NETWORK="${NETWORK:-cgm-vpc}"
SUBNET_REGION="${SUBNET_REGION:?SUBNET_REGION (any sandbox subnet region; broker overrides per VM) is required}"

g() { gcloud --project "$PROJECT" "$@"; }

if g compute instance-templates describe "$TEMPLATE" >/dev/null 2>&1; then
  echo "instance template $TEMPLATE exists（模板不可修改；如需更新请先删除或换名，并更新 broker 的 INSTANCE_TEMPLATE）"
  exit 0
fi

g compute instance-templates create "$TEMPLATE" \
  --machine-type "$MACHINE" \
  --image-family "$IMAGE_FAMILY" --image-project "$PROJECT" \
  --boot-disk-type hyperdisk-balanced --boot-disk-size "${DISK_GB}GB" \
  --network-interface "network=$NETWORK,subnet=projects/$PROJECT/regions/$SUBNET_REGION/subnetworks/cgm-sandbox-$SUBNET_REGION,nic-type=GVNIC,no-address,stack-type=IPV4_ONLY" \
  --tags cgm-sandbox \
  --no-service-account --no-scopes \
  --provisioning-model SPOT --instance-termination-action DELETE --max-run-duration "$MAX_RUN" \
  --no-restart-on-failure --maintenance-policy TERMINATE \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE,serial-port-enable=FALSE

echo "instance template: $TEMPLATE"
