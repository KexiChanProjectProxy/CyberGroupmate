#!/usr/bin/env bash
# fetch-host-certs.sh — 在 host VM 启动时从 Secret Manager 取出 mTLS 客户端证书到 tmpfs
#
# 用法（systemd ExecStartPre 或容器 entrypoint 之前）：
#   scripts/sandbox-vm/fetch-host-certs.sh /run/cgm-tls
# config.yaml：
#   sandbox.remote.tls: { ca: /run/cgm-tls/ca.crt, cert: /run/cgm-tls/client.crt, key: /run/cgm-tls/client.key }
set -euo pipefail

OUT="${1:-/run/cgm-tls}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

install -d -m 0700 "$OUT"
if ! mountpoint -q "$OUT"; then
  mount -t tmpfs -o size=1m,mode=0700 tmpfs "$OUT"
fi
umask 077
gcloud secrets versions access latest --secret cgm-sandbox-ca --project "$PROJECT" > "$OUT/ca.crt"
gcloud secrets versions access latest --secret cgm-sandbox-client-crt --project "$PROJECT" > "$OUT/client.crt"
gcloud secrets versions access latest --secret cgm-sandbox-client-key --project "$PROJECT" > "$OUT/client.key"
echo "mTLS client material written to $OUT"
