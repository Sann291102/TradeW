#!/usr/bin/env bash
# TradeW Postgres backup -> OCI Object Storage.
# Nightly pg_dump (compressed), uploaded via rclone, with retention pruning.
#
# Setup (once on the VM):
#   1. Install rclone and configure an OCI Object Storage remote (S3-compatible):
#        rclone config   # remote name must match BACKUP_RCLONE_REMOTE
#   2. Create the bucket named by BACKUP_BUCKET.
#   3. Cron (daily 02:30):
#        30 2 * * * cd /opt/tradew && ./infra/docker/backup.sh >> /var/log/tradew-backup.log 2>&1
#
# Restore:
#   rclone copy $REMOTE:$BUCKET/tradew-YYYYMMDD-HHMMSS.sql.gz .
#   gunzip -c tradew-*.sql.gz | docker compose -f infra/docker/docker-compose.prod.yml \
#     exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
set -a; [ -f .env.prod ] && . .env.prod; set +a

COMPOSE="docker compose -f infra/docker/docker-compose.prod.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="tradew-${STAMP}.sql.gz"
REMOTE="${BACKUP_RCLONE_REMOTE:?set BACKUP_RCLONE_REMOTE}"
BUCKET="${BACKUP_BUCKET:?set BACKUP_BUCKET}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"

echo "[$(date -Is)] dumping $POSTGRES_DB -> $FILE"
$COMPOSE exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "/tmp/$FILE"

echo "[$(date -Is)] uploading to $REMOTE:$BUCKET"
rclone copy "/tmp/$FILE" "$REMOTE:$BUCKET/"
rm -f "/tmp/$FILE"

echo "[$(date -Is)] pruning backups older than ${RETENTION}d"
rclone delete --min-age "${RETENTION}d" "$REMOTE:$BUCKET/"

echo "[$(date -Is)] backup complete: $FILE"
