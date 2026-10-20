#!/usr/bin/env bash
# gcp-network.sh — 创建 VPC、子网与 sandbox VM 防火墙规则
#
# 用法：REGION=asia-east1 scripts/sandbox-vm/gcp-network.sh [<project>]
#       临时 VM 模式：再加 SANDBOX_REGIONS="northamerica-northeast1 europe-west9 ..."，
#       为每个候选 region 建子网 cgm-sandbox-<region>（10.20.N.0/24；全局 VPC 内网互通，无 NAT / PGA）
#
# 设计：
# - 子网关闭 Private Google Access、不配置 Cloud NAT → sandbox VM 无任何出公网路径
# - sandbox（tag cgm-sandbox）egress 全部拒绝（priority 100，高于任何 allow）；
#   VPC 防火墙是有状态的：host 发起的连接的回包不受 egress 规则影响
# - sandbox ingress 只允许 host（tag cgm-host）访问 7443 与 22，以及 IAP 的 22
# - host 的出口管控（LLM / Telegram 白名单代理）不在本脚本范围
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:?REGION is required}"
NETWORK="${NETWORK:-cgm-vpc}"
SUBNET="${SUBNET:-cgm-subnet}"
RANGE="${RANGE:-10.10.0.0/24}"
PORT="${SANDBOXD_PORT:-7443}"

g() { gcloud --project "$PROJECT" "$@"; }

g compute networks describe "$NETWORK" >/dev/null 2>&1 || \
  g compute networks create "$NETWORK" --subnet-mode=custom
g compute networks subnets describe "$SUBNET" --region "$REGION" >/dev/null 2>&1 || \
  g compute networks subnets create "$SUBNET" --network "$NETWORK" --region "$REGION" \
    --range "$RANGE" --no-enable-private-ip-google-access

n=0
for r in ${SANDBOX_REGIONS:-}; do
  n=$((n + 1))
  g compute networks subnets describe "cgm-sandbox-$r" --region "$r" >/dev/null 2>&1 || \
    g compute networks subnets create "cgm-sandbox-$r" --network "$NETWORK" --region "$r" \
      --range "10.20.$n.0/24" --no-enable-private-ip-google-access
done

rule() {
  local name="$1"; shift
  if g compute firewall-rules describe "$name" >/dev/null 2>&1; then
    echo "firewall rule $name exists, skipping"
  else
    g compute firewall-rules create "$name" --network "$NETWORK" "$@"
  fi
}

rule cgm-sandbox-allow-sandboxd --direction INGRESS --priority 1000 --action ALLOW \
  --rules "tcp:${PORT}" --source-tags cgm-host --target-tags cgm-sandbox
rule cgm-sandbox-allow-ssh --direction INGRESS --priority 1000 --action ALLOW \
  --rules tcp:22 --source-tags cgm-host --target-tags cgm-sandbox
rule cgm-sandbox-allow-iap-ssh --direction INGRESS --priority 1000 --action ALLOW \
  --rules tcp:22 --source-ranges 35.235.240.0/20 --target-tags cgm-sandbox
rule cgm-sandbox-deny-ingress --direction INGRESS --priority 65000 --action DENY \
  --rules all --source-ranges 0.0.0.0/0 --target-tags cgm-sandbox
rule cgm-sandbox-deny-egress --direction EGRESS --priority 100 --action DENY \
  --rules all --destination-ranges 0.0.0.0/0 --target-tags cgm-sandbox
# daemon / builder（tag cgm-admin）：只允许 IAP 的 SSH 入站（独立 VPC，不与其他网络互通）
rule cgm-admin-allow-iap-ssh --direction INGRESS --priority 1000 --action ALLOW \
  --rules tcp:22 --source-ranges 35.235.240.0/20 --target-tags cgm-admin

echo "network ready: $NETWORK/$SUBNET ($RANGE)"
