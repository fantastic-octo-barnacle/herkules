#!/bin/sh
# Nightly: pg_dump (custom format) of every database in DATABASES streamed to R2, then prune old dumps.
# Env: PGHOST/PGUSER/PGPASSWORD, DATABASES (space-separated, default "herkules"), R2_BUCKET,
# R2_PREFIX (default herkules), BACKUP_KEEP_DAYS (default 30), and rclone's remote from
# RCLONE_CONFIG_R2_* (see tools/deploy/.env.example).
set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="r2:${R2_BUCKET}/${R2_PREFIX:-herkules}"
for db in ${DATABASES:-herkules}; do
	pg_dump --format=custom --no-owner --dbname="$db" | rclone rcat "${dest}/${db}-${stamp}.dump"
	echo "backup: ${dest}/${db}-${stamp}.dump"
done
rclone delete "$dest" --min-age "${BACKUP_KEEP_DAYS:-30}d"

# Heartbeat to the status page (tools/deploy/gatus.yaml "Backups", key platform_backups):
# only reached after every dump uploaded (set -e), so silence = a missed night. busybox
# wget: no curl in this image. Best effort — a status-page hiccup must not fail the backup.
if [ -n "${GATUS_URL:-}" ] && [ -n "${GATUS_BACKUP_TOKEN:-}" ]; then
	wget -q -O /dev/null --header "Authorization: Bearer ${GATUS_BACKUP_TOKEN}" --post-data "" \
		"${GATUS_URL}/api/v1/endpoints/platform_backups/external?success=true" \
		|| echo "backup: status-page heartbeat failed (ignored)" >&2
fi
