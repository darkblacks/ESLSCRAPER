#!/usr/bin/env bash
# Backup dos dados persistentes do backend (histórico, de-para, config do /admin) + .env.
# Uso: sudo ops/backup.sh [motivo]     Destino: /var/backups/esl-scraper (mantém os 30 mais recentes)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-/var/backups/esl-scraper}"
KEEP="${BACKUP_KEEP:-30}"
MOTIVO="${1:-manual}"
install -d -m 700 "$DEST"
ARQ="$DEST/esl-data-$(date +%Y%m%d-%H%M%S)-${MOTIVO//[^a-zA-Z0-9_-]/}.tar.gz"
umask 077
tar -C "$REPO" -czf "$ARQ" backend-data .env
echo "backup: $ARQ ($(du -h "$ARQ" | cut -f1))"
ls -1t "$DEST"/esl-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
