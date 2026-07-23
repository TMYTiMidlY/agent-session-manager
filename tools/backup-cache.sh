#!/usr/bin/env bash
# Restore agent history from a restic snapshot into a LOCAL cache directory —
# the read side of asmgr (search/show/html/md over `--source cache`).
#
# Usage: tools/backup-cache.sh [snapshot] <target-dir> [extra restic args...]
#   snapshot   restic snapshot id or "latest" (default: latest)
#   target-dir destination cache dir (MUST be outside ~/.copilot|.claude|.codex)
#
# Credentials/repo come from secrets.env, same as backup.sh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; source "$DIR/secrets.env"; set +a

RESTIC="${RESTIC_BIN:-$HOME/.local/bin/restic}"

SNAPSHOT="${1:-latest}"
TARGET="${2:-}"
[ -n "$TARGET" ] || { echo "target dir required" >&2; exit 2; }
shift 2 2>/dev/null || shift $# 

mkdir -p "$TARGET"

echo "[$(date '+%F %T')] === asmgr backup cache: restore $SNAPSHOT -> $TARGET ==="
"$RESTIC" restore "$SNAPSHOT" \
  --target "$TARGET" \
  --tag agent-session-manager \
  "$@"
echo "[$(date '+%F %T')] === done ==="
