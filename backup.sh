#!/usr/bin/env bash
# Agent session history incremental backup —— restic → S3-compatible (or any restic backend)
# 用法: ./backup.sh [--dry-run]
#
# 所有"打到哪台机、哪个 bucket、走什么端口"都来自 secrets.env，本脚本通用。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 凭据 + 仓库地址（RESTIC_REPOSITORY / AWS_* / RESTIC_PASSWORD / 可选 RESTIC_BIN / BACKUP_AGENT_DIRS / BACKUP_EXCLUDE_REWIND）
set -a; source "$DIR/secrets.env"; set +a

RESTIC="${RESTIC_BIN:-$HOME/.local/bin/restic}"
BACKUP_AGENT_DIRS="${BACKUP_AGENT_DIRS:-$HOME/.copilot:$HOME/.claude:$HOME/.codex}"

DRYRUN=""
[ "${1:-}" = "--dry-run" ] && DRYRUN="--dry-run"

echo "[$(date '+%F %T')] === agent-session-exporter 备份开始 ${DRYRUN:+(dry-run)} ==="

# 1) SQLite 一致性：把 WAL 合进主库并清空，使备份到的 .db 自洽
#    库正被活跃 copilot 进程独占时 checkpoint 是 best-effort，失败不影响主库一致性
COPILOT_DB="$HOME/.copilot/session-store.db"
if [ -z "$DRYRUN" ] && [ -f "$COPILOT_DB" ]; then
  python3 - "$COPILOT_DB" <<'PY' || true
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1], timeout=5)
    c.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    c.close()
    print("  session-store.db WAL checkpoint ok")
except Exception as e:
    print("  checkpoint skipped:", e)
PY
fi

# 2) 备份（CDC 去重增量；首份全量，之后只传净增字节）
#    --exclude-file 里只放 glob（SQLite 热文件 / 锁）；锚定到具体 agent home 下的路径
#    在此处用 --exclude 拼出，避免 exclude.txt 硬编码绝对路径
IFS=':' read -r -a SOURCE_DIRS <<< "$BACKUP_AGENT_DIRS"
EXISTING_SOURCE_DIRS=()
for src in "${SOURCE_DIRS[@]}"; do
  [ -d "$src" ] && EXISTING_SOURCE_DIRS+=( "$src" )
done
[ "${#EXISTING_SOURCE_DIRS[@]}" -gt 0 ] || { echo "no agent state directories found" >&2; exit 2; }

EXCLUDE_ARGS=(
  --exclude "$HOME/.copilot/logs"
)
if [ "${BACKUP_EXCLUDE_REWIND:-0}" = "1" ]; then
  EXCLUDE_ARGS+=( --exclude "$HOME/.copilot/session-state/*/rewind-snapshots" )
fi

"$RESTIC" backup "${EXISTING_SOURCE_DIRS[@]}" \
  --exclude-file "$DIR/exclude.txt" \
  "${EXCLUDE_ARGS[@]}" \
  --tag agent-session-exporter --tag "$(hostname)" \
  $DRYRUN

# 3) 保留策略 + prune（dry-run 时跳过）
if [ -z "$DRYRUN" ]; then
  echo "[$(date '+%F %T')] === forget + prune ==="
  "$RESTIC" forget --tag agent-session-exporter \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 \
    --prune
fi

echo "[$(date '+%F %T')] === 完成 ==="
