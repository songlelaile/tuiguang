#!/usr/bin/env bash
# 备份 uploads 目录到 BACKUP_DIR，并滚动保留最近 KEEP 份。
# 用法：
#   UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads BACKUP_DIR=/var/backups/tuiguang KEEP=14 ./deploy/backup.sh

set -euo pipefail

UPLOADS_HOST_DIR="${UPLOADS_HOST_DIR:-./uploads}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tuiguang}"
KEEP="${KEEP:-14}"

if [ ! -d "$UPLOADS_HOST_DIR" ]; then
  echo "✗ uploads 目录不存在：$UPLOADS_HOST_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUTPUT="$BACKUP_DIR/tuiguang-uploads-$TS.tar.gz"

echo "→ 打包 $UPLOADS_HOST_DIR → $OUTPUT"
tar -czf "$OUTPUT" -C "$(dirname "$UPLOADS_HOST_DIR")" "$(basename "$UPLOADS_HOST_DIR")"
echo "✓ 完成 $(du -h "$OUTPUT" | cut -f1)"

# 滚动清理
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/tuiguang-uploads-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [ "${#OLD[@]}" -gt 0 ]; then
  printf '→ 清理旧备份：%s\n' "${OLD[@]}"
  rm -f "${OLD[@]}"
fi
echo "→ 当前保留 $(ls -1 "$BACKUP_DIR"/tuiguang-uploads-*.tar.gz 2>/dev/null | wc -l | tr -d ' ') 份"
