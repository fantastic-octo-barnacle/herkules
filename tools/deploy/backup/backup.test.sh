#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
mkdir "$test_dir/bin"
cp "$here/mock-command.sh" "$test_dir/bin/pg_dump"
cp "$here/mock-command.sh" "$test_dir/bin/rclone"
chmod +x "$test_dir/bin/pg_dump" "$test_dir/bin/rclone"

export BACKUP_TEST_LOG="$test_dir/commands.log"
export BACKUP_TEST_OBJECT="$test_dir/object"
export PATH="$test_dir/bin:$PATH"
export PGHOST=postgres
export PGUSER=herkules
export PGPASSWORD=test-password
export DATABASES="herkules bbs"
export R2_BUCKET=test-bucket
export R2_PREFIX=herkules
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=test-access-key
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=test-secret-key
export RCLONE_CONFIG_R2_ENDPOINT=https://example.invalid
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

output=$(sh "$here/backup.sh" preflight)
printf '%s\n' "$output" | grep -Fq "backup: preflight OK"
grep -Fq "pg_dump <--schema-only> <--no-owner> <--dbname=herkules>" "$BACKUP_TEST_LOG"
grep -Fq "pg_dump <--schema-only> <--no-owner> <--dbname=bbs>" "$BACKUP_TEST_LOG"
grep -Fq "rclone <rcat> <r2:test-bucket/herkules/.preflight>" "$BACKUP_TEST_LOG"
grep -Fq "rclone <cat> <r2:test-bucket/herkules/.preflight>" "$BACKUP_TEST_LOG"
grep -Fq "rclone <deletefile> <r2:test-bucket/herkules/.preflight>" "$BACKUP_TEST_LOG"
test ! -e "$BACKUP_TEST_OBJECT"

if env -u R2_BUCKET sh "$here/backup.sh" preflight >"$test_dir/missing.out" 2>&1; then
	echo "preflight accepted a missing R2_BUCKET" >&2
	exit 1
fi
grep -Fq "backup: R2_BUCKET is required" "$test_dir/missing.out"

: >"$BACKUP_TEST_LOG"
if BACKUP_TEST_PG_DUMP_FAIL=true sh "$here/backup.sh" run >"$test_dir/dump-failure.out" 2>&1; then
	echo "backup accepted a failed pg_dump stream" >&2
	exit 1
fi
grep -Fq "backup: pg_dump failed for herkules; partial R2 object removed" "$test_dir/dump-failure.out"
grep -Fq "rclone <deletefile> <r2:test-bucket/herkules/herkules-" "$BACKUP_TEST_LOG"

echo "backup preflight tests passed"
