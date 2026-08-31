#!/bin/sh
# Commands:
#   backup             pg_dump every database to R2, then prune old dumps
#   backup preflight   prove database reads and R2 write/read/delete before cron starts
# Env: PGHOST/PGUSER/PGPASSWORD, DATABASES (space-separated, default "herkules"), R2_BUCKET,
# R2_PREFIX (default herkules), BACKUP_KEEP_DAYS (default 30), and rclone's remote from
# RCLONE_CONFIG_R2_* (see tools/deploy/.env.example).
set -eu

require_config() {
	: "${PGHOST:?backup: PGHOST is required}"
	: "${PGUSER:?backup: PGUSER is required}"
	: "${PGPASSWORD:?backup: PGPASSWORD is required}"
	: "${R2_BUCKET:?backup: R2_BUCKET is required}"
	: "${RCLONE_CONFIG_R2_TYPE:?backup: RCLONE_CONFIG_R2_TYPE is required}"
	: "${RCLONE_CONFIG_R2_PROVIDER:?backup: RCLONE_CONFIG_R2_PROVIDER is required}"
	: "${RCLONE_CONFIG_R2_ACCESS_KEY_ID:?backup: RCLONE_CONFIG_R2_ACCESS_KEY_ID is required}"
	: "${RCLONE_CONFIG_R2_SECRET_ACCESS_KEY:?backup: RCLONE_CONFIG_R2_SECRET_ACCESS_KEY is required}"
	: "${RCLONE_CONFIG_R2_ENDPOINT:?backup: RCLONE_CONFIG_R2_ENDPOINT is required}"
	: "${RCLONE_CONFIG_R2_NO_CHECK_BUCKET:?backup: RCLONE_CONFIG_R2_NO_CHECK_BUCKET is required}"
	if [ "$RCLONE_CONFIG_R2_NO_CHECK_BUCKET" != "true" ]; then
		echo "backup: RCLONE_CONFIG_R2_NO_CHECK_BUCKET must be true for Cloudflare R2" >&2
		exit 1
	fi
}

destination() {
	printf 'r2:%s/%s' "$R2_BUCKET" "${R2_PREFIX:-herkules}"
}

preflight() {
	require_config
	for db in ${DATABASES:-herkules}; do
		pg_dump --schema-only --no-owner --dbname="$db" >/dev/null
	done

	dest=$(destination)
	canary="${dest}/.preflight"
	payload="herkules backup preflight"
	trap 'rclone deletefile "$canary" >/dev/null 2>&1 || true' EXIT HUP INT TERM
	printf '%s' "$payload" | rclone rcat "$canary"
	readback=$(rclone cat "$canary")
	if [ "$readback" != "$payload" ]; then
		echo "backup: R2 preflight read did not match the write" >&2
		exit 1
	fi
	rclone deletefile "$canary"
	trap - EXIT HUP INT TERM
	echo "backup: preflight OK"
}

stream_dump() {
	db=$1
	target=$2
	transfer_dir=$(mktemp -d)
	fifo="$transfer_dir/dump"
	mkfifo "$fifo"
	trap 'rm -rf "$transfer_dir"' EXIT HUP INT TERM

	pg_dump --format=custom --no-owner --dbname="$db" >"$fifo" &
	dump_pid=$!
	if ! rclone rcat "$target" <"$fifo"; then
		wait "$dump_pid" 2>/dev/null || true
		rclone deletefile "$target" >/dev/null 2>&1 || true
		echo "backup: R2 upload failed for $db; partial object removed" >&2
		rm -rf "$transfer_dir"
		trap - EXIT HUP INT TERM
		return 1
	fi
	if ! wait "$dump_pid"; then
		rclone deletefile "$target" >/dev/null 2>&1 || true
		echo "backup: pg_dump failed for $db; partial R2 object removed" >&2
		rm -rf "$transfer_dir"
		trap - EXIT HUP INT TERM
		return 1
	fi

	rm -rf "$transfer_dir"
	trap - EXIT HUP INT TERM
}

run_backup() {
	require_config
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	dest=$(destination)
	for db in ${DATABASES:-herkules}; do
		target="${dest}/${db}-${stamp}.dump"
		stream_dump "$db" "$target"
		echo "backup: $target"
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
}

case "${1:-run}" in
	preflight)
		preflight
		;;
	run)
		run_backup
		;;
	*)
		echo "usage: backup [preflight|run]" >&2
		exit 2
		;;
esac
