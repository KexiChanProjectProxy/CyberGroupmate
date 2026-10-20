#!/usr/bin/env bash
# homes-quota.sh — 为每个 chat home 设置 ext4 project quota（由 cgm-homes-quota.timer 每分钟调用）
#
# homes PD 需以 `mkfs.ext4 -O quota,project` 创建并以 prjquota 挂载（见 setup-vm.sh）。
# 每个 home 使用一个由目录名派生的 project id；已设置过的目录跳过。
set -euo pipefail

HOMES_MOUNT="${HOMES_MOUNT:-/var/lib/cgm}"
HOMES_DIR="${HOMES_MOUNT}/homes"
BLOCKS_KB="${HOME_QUOTA_BLOCKS_KB:-5242880}"   # 5 GiB
INODES="${HOME_QUOTA_INODES:-200000}"

[ -d "$HOMES_DIR" ] || exit 0

for dir in "$HOMES_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [[ "$name" =~ ^[a-f0-9]{32}$ ]] || continue
  # 由目录名的前 7 个 hex 派生 project id（1..268435455），避免维护映射表
  projid=$(( 16#${name:0:7} + 1 ))
  current="$(lsattr -pd "$dir" 2>/dev/null | awk '{print $1}')"
  if [ "$current" = "$projid" ]; then
    continue
  fi
  chattr +P -p "$projid" "$dir"
  # 已有内容也归入该 project
  find "$dir" -xdev \( -type f -o -type d \) -exec chattr -p "$projid" {} + 2>/dev/null || true
  setquota -P "$projid" 0 "$BLOCKS_KB" 0 "$INODES" "$HOMES_MOUNT"
done
