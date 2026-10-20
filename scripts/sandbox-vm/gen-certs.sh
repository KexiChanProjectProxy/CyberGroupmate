#!/usr/bin/env bash
# gen-certs.sh — 生成 host ⇄ sandboxd 的 mTLS 证书（在操作者本机运行；CA 私钥不上任何 VM）
#
# 用法：scripts/sandbox-vm/gen-certs.sh <out-dir> <sandbox-name> <sandbox-internal-ip> [<dns-name>]
# 例：  scripts/sandbox-vm/gen-certs.sh ./certs cgm-sandbox-1 10.10.0.3 cgm-sandbox-1
#
# 产物：
#   ca.crt / ca.key                    —— CA（ca.key 离线保存）
#   <sandbox-name>.crt / .key          —— sandboxd 服务端证书（SAN = IP + DNS）
#   host-client.crt / .key             —— host 客户端证书（放 Secret Manager）
#   allowed-clients                    —— 客户端证书 SHA-256 指纹（放 sandbox VM）
# 已存在的 CA / 客户端证书会被复用（用于为新增 sandbox VM 签发服务端证书）。
set -euo pipefail

OUT="${1:?out dir}"
NAME="${2:?sandbox name}"
IP="${3:?sandbox internal ip}"
DNS="${4:-$NAME}"
DAYS_LEAF=397
DAYS_CA=3650

mkdir -p "$OUT"
cd "$OUT"
umask 077

if [ ! -f ca.key ]; then
  openssl ecparam -genkey -name prime256v1 -noout -out ca.key
  openssl req -x509 -new -key ca.key -days "$DAYS_CA" -subj "/CN=cgm-sandbox-ca" -out ca.crt
fi

openssl ecparam -genkey -name prime256v1 -noout -out "$NAME.key"
openssl req -new -key "$NAME.key" -subj "/CN=$NAME" -out "$NAME.csr"
printf "subjectAltName=IP:%s,DNS:%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n" "$IP" "$DNS" > "$NAME.ext"
openssl x509 -req -in "$NAME.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS_LEAF" -extfile "$NAME.ext" -out "$NAME.crt"
rm -f "$NAME.csr" "$NAME.ext"

if [ ! -f host-client.key ]; then
  openssl ecparam -genkey -name prime256v1 -noout -out host-client.key
  openssl req -new -key host-client.key -subj "/CN=cgm-host" -out host-client.csr
  printf "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n" > host-client.ext
  openssl x509 -req -in host-client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS_LEAF" -extfile host-client.ext -out host-client.crt
  rm -f host-client.csr host-client.ext
fi

openssl x509 -in host-client.crt -noout -fingerprint -sha256 | sed 's/.*=//' > allowed-clients
chmod 644 ca.crt "$NAME.crt" host-client.crt allowed-clients

echo "生成完成：$OUT"
echo "  sandbox VM 需要：ca.crt  $NAME.crt  $NAME.key  allowed-clients"
echo "  host VM 需要：   ca.crt  host-client.crt  host-client.key（建议放入 Secret Manager）"
echo "  ca.key 请离线保存，不要上传到任何 VM"
