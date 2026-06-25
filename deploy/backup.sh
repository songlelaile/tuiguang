#!/usr/bin/env bash
# 备份 uploads 目录 + SQLite 历史库到 BACKUP_DIR，并滚动保留最近 KEEP 份。
# 用法：
#   UPLOADS_HOST_DIR=/var/lib/tuiguang/uploads \
#   DATA_HOST_DIR=/var/lib/tuiguang/data \
#   BACKUP_DIR=/var/backups/tuiguang KEEP=14 ./deploy/backup.sh

set -euo pipefail

UPLOADS_HOST_DIR="${UPLOADS_HOST_DIR:-./uploads}"
DATA_HOST_DIR="${DATA_HOST_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tuiguang}"
KEEP="${KEEP:-14}"

if [ ! -d "$UPLOADS_HOST_DIR" ]; then
  echo "✗ uploads 目录不存在：$UPLOADS_HOST_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUTPUT="$BACKUP_DIR/tuiguang-$TS.tar.gz"

# 打包 uploads + data 两个目录（data 含 SQLite 历史库）
echo "→ 打包 uploads + data → $OUTPUT"
PARENT_UPLOAD="$(dirname "$UPLOADS_HOST_DIR")"
BASE_UPLOAD="$(basename "$UPLOADS_HOST_DIR")"
if [ -d "$DATA_HOST_DIR" ]; then
  PARENT_DATA="$(dirname "$DATA_HOST_DIR")"
  BASE_DATA="$(basename "$DATA_HOST_DIR")"
  if [ "$PARENT_UPLOAD" = "$PARENT_DATA" ]; then
    tar -czf "$OUTPUT" -C "$PARENT_UPLOAD" "$BASE_UPLOAD" "$BASE_DATA"
  else
    # 不同父目录：临时复制聚合再打包
    STAGE="$(mktemp -d)"
    cp -r "$UPLOADS_HOST_DIR" "$STAGE/uploads"
    cp -r "$DATA_HOST_DIR" "$STAGE/data"
    tar -czf "$OUTPUT" -C "$STAGE" uploads data
    rm -rf "$STAGE"
  fi
else
  echo "  (data 目录 $DATA_HOST_DIR 不存在，仅备份 uploads)"
  tar -czf "$OUTPUT" -C "$PARENT_UPLOAD" "$BASE_UPLOAD"
fi
echo "✓ 完成 $(du -h "$OUTPUT" | cut -f1)"

# 滚动清理
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/tuiguang-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [ "${#OLD[@]}" -gt 0 ]; then
  printf '→ 清理旧备份：%s\n' "${OLD[@]}"
  rm -f "${OLD[@]}"
fi
echo "→ 当前保留 $(ls -1 "$BACKUP_DIR"/tuiguang-*.tar.gz 2>/dev/null | wc -l | tr -d ' ') 份"
