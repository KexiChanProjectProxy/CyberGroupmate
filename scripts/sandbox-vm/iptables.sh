#!/usr/bin/env bash
# iptables.sh — sandbox VM 的主机防火墙（VPC 防火墙之外的第二道防线）
#
# - INPUT 默认 DROP：只允许 host VM 访问 sandboxd 端口与 ssh、IAP ssh、回包
# - OUTPUT 默认 DROP：只允许回包与 metadata server（OS Login / NTP 需要）
# - DOCKER-USER：任何容器流量一律丢弃（session 容器本就 --network none，这里是纵深防御），
#   并显式拒绝访问 metadata server
#
# 环境变量见 deploy/sandbox/vm.env.example
set -euo pipefail

: "${HOST_VM_IP:?HOST_VM_IP is required}"
IAP_RANGE="${IAP_RANGE:-35.235.240.0/20}"
SANDBOXD_PORT="${SANDBOXD_PORT:-7443}"
METADATA=169.254.169.254

ipt() { iptables -w "$@"; }

# ── INPUT ──
ipt -P INPUT DROP
ipt -F INPUT
ipt -A INPUT -i lo -j ACCEPT
ipt -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ipt -A INPUT -p tcp -s "$HOST_VM_IP" --dport "$SANDBOXD_PORT" -j ACCEPT
ipt -A INPUT -p tcp -s "$HOST_VM_IP" --dport 22 -j ACCEPT
ipt -A INPUT -p tcp -s "$IAP_RANGE" --dport 22 -j ACCEPT
ipt -A INPUT -p icmp --icmp-type fragmentation-needed -j ACCEPT

# ── OUTPUT ──
ipt -P OUTPUT DROP
ipt -F OUTPUT
ipt -A OUTPUT -o lo -j ACCEPT
ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# VM 自身（guest agent / OS Login / NTP）需要 metadata server；容器不需要（见 DOCKER-USER）
ipt -A OUTPUT -d "$METADATA" -m owner --uid-owner 0 -j ACCEPT

# ── FORWARD / DOCKER-USER ──
ipt -P FORWARD DROP
ipt -N DOCKER-USER 2>/dev/null || true
ipt -F DOCKER-USER
ipt -A DOCKER-USER -d "$METADATA" -j REJECT --reject-with icmp-admin-prohibited
ipt -A DOCKER-USER -j DROP

# ── IPv6：全部丢弃（VPC 为 IPv4-only） ──
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -w -P INPUT DROP
  ip6tables -w -P FORWARD DROP
  ip6tables -w -P OUTPUT DROP
  ip6tables -w -F INPUT
  ip6tables -w -F OUTPUT
  ip6tables -w -A INPUT -i lo -j ACCEPT
  ip6tables -w -A OUTPUT -o lo -j ACCEPT
fi

echo "sandbox VM firewall applied (host=${HOST_VM_IP}, port=${SANDBOXD_PORT})"
