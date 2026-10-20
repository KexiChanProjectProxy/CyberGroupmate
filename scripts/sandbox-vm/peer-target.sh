#!/usr/bin/env bash
# peer-target.sh — 让 daemon VM（且仅 daemon）访问另一个 VPC 中的单个 IP
#
# 建立 cgm-vpc ⇄ <peer-network> 的 VPC peering，并在 cgm-vpc 一侧用防火墙收紧：
#   - 允许：daemon（按服务账号匹配）→ TARGET_IP/32（优先级 90）
#   - 拒绝：cgm-vpc 内任何实例 → PEER_RANGE（优先级 95；sandbox VM 另有 deny-all egress）
#   - 拒绝：PEER_RANGE → cgm-vpc 任何实例（ingress，优先级 500）
# sandbox VM 没有服务账号，无法匹配允许规则；tag 不跨 peering 传递。
# 先创建防火墙规则再建立 peering，避免出现未受限的窗口。
#
# 用法：TARGET_IP=10.128.0.10 PEER_NETWORK=default PEER_RANGE=10.128.0.0/9 \
#       DAEMON_SA=cgm-daemon@PROJECT.iam.gserviceaccount.com scripts/sandbox-vm/peer-target.sh [<project>]
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
TARGET_IP="${TARGET_IP:?TARGET_IP is required}"
PEER_NETWORK="${PEER_NETWORK:?PEER_NETWORK is required}"
PEER_RANGE="${PEER_RANGE:?PEER_RANGE (CIDR covering the peer network) is required}"
DAEMON_SA="${DAEMON_SA:?DAEMON_SA is required}"
NETWORK="${NETWORK:-cgm-vpc}"

g() { gcloud --project "$PROJECT" "$@"; }
rule() {
  local name="$1"; shift
  g compute firewall-rules describe "$name" >/dev/null 2>&1 && { echo "firewall rule $name exists"; return; }
  g compute firewall-rules create "$name" --network "$NETWORK" "$@"
}

rule cgm-peer-deny-ingress-${PEER_NETWORK} --direction INGRESS --priority 500 --action DENY --rules all --source-ranges "$PEER_RANGE"
rule cgm-peer-allow-daemon-to-target --direction EGRESS --priority 90 --action ALLOW --rules all \
  --destination-ranges "$TARGET_IP/32" --target-service-accounts "$DAEMON_SA"
rule cgm-peer-deny-egress-${PEER_NETWORK} --direction EGRESS --priority 95 --action DENY --rules all --destination-ranges "$PEER_RANGE"

g compute networks peerings list --network "$NETWORK" --format="value(name)" | grep -qx "$NETWORK-to-$PEER_NETWORK" || \
  g compute networks peerings create "$NETWORK-to-$PEER_NETWORK" --network "$NETWORK" --peer-network "$PEER_NETWORK"
g compute networks peerings list --network "$PEER_NETWORK" --format="value(name)" | grep -qx "$PEER_NETWORK-to-$NETWORK" || \
  g compute networks peerings create "$PEER_NETWORK-to-$NETWORK" --network "$PEER_NETWORK" --peer-network "$NETWORK"

echo "peering ready. 注意：目标 VM 自身的主机防火墙（nftables / ufw）也需放行来自 daemon IP 的端口。"
