#!/bin/sh
# Nightly: pg_dump (custom format) streamed to R2, then prune old dumps.
# Env: DATABASE_URL, R2_BUCKET, R2_PREFIX (default herkules), BACKUP_KEEP_DAYS (default 30),
# and rclone's remote from RCLONE_CONFIG_R2_* (see tools/deploy/.env.example).
set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="r2:${R2_BUCKET}/${R2_PREFIX:-herkules}"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" | rclone rcat "${dest}/auth-${stamp}.dump"
rclone delete "$dest" --min-age "${BACKUP_KEEP_DAYS:-30}d"
echo "backup: ${dest}/auth-${stamp}.dump"
