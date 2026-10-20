#!/usr/bin/env bash
# install-certs.sh — 把 sandboxd 证书安装到 sandbox VM（经 IAP SSH），并把 host 证书写入 Secret Manager
#
# 用法：scripts/sandbox-vm/install-certs.sh <cert-dir> <sandbox-name> <zone> [<project>]
set -euo pipefail

DIR="${1:?cert dir}"
NAME="${2:?sandbox vm name}"
ZONE="${3:?zone}"
PROJECT="${4:-$(gcloud config get-value project 2>/dev/null)}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$DIR/ca.crt" "$tmp/ca.crt"
cp "$DIR/$NAME.crt" "$tmp/server.crt"
cp "$DIR/$NAME.key" "$tmp/server.key"
cp "$DIR/allowed-clients" "$tmp/allowed-clients"

gcloud compute scp --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap \
  "$tmp/ca.crt" "$tmp/server.crt" "$tmp/server.key" "$tmp/allowed-clients" "$NAME:/tmp/"
gcloud compute ssh --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap "$NAME" -- \
  'sudo install -d -m 0700 /etc/cgm/tls && \
   sudo install -m 0644 /tmp/ca.crt /tmp/server.crt /tmp/allowed-clients /etc/cgm/tls/ && \
   sudo install -m 0600 /tmp/server.key /etc/cgm/tls/server.key && \
   rm -f /tmp/ca.crt /tmp/server.crt /tmp/server.key /tmp/allowed-clients && \
   (sudo systemctl reload cgm-sandboxd 2>/dev/null || true)'

# host 证书 → Secret Manager（仅 host VM 的服务账号有 secretAccessor）
for pair in "cgm-sandbox-ca:ca.crt" "cgm-sandbox-client-crt:host-client.crt" "cgm-sandbox-client-key:host-client.key"; do
  secret="${pair%%:*}"
  file="${pair#*:}"
  if ! gcloud secrets describe "$secret" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$secret" --project "$PROJECT" --replication-policy=automatic
  fi
  gcloud secrets versions add "$secret" --project "$PROJECT" --data-file="$DIR/$file"
done
echo "证书已安装到 $NAME，并更新了 Secret Manager（cgm-sandbox-ca / -client-crt / -client-key）"
