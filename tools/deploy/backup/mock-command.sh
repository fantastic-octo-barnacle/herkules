#!/bin/sh
set -eu

command_name=${0##*/}
printf '%s' "$command_name" >>"$BACKUP_TEST_LOG"
for argument in "$@"; do
	printf ' <%s>' "$argument" >>"$BACKUP_TEST_LOG"
done
printf '\n' >>"$BACKUP_TEST_LOG"

case "$command_name" in
	pg_dump)
		if [ "${BACKUP_TEST_PG_DUMP_FAIL:-}" = "true" ]; then
			exit 9
		fi
		printf 'mock dump\n'
		;;
	rclone)
		subcommand=$1
		case "$subcommand" in
			rcat)
				cat >"$BACKUP_TEST_OBJECT"
				;;
			cat)
				cat "$BACKUP_TEST_OBJECT"
				;;
			deletefile)
				rm -f "$BACKUP_TEST_OBJECT"
				;;
			delete)
				;;
			*)
				echo "unexpected rclone command: $subcommand" >&2
				exit 1
				;;
		esac
		;;
	*)
		echo "unexpected mock command: $command_name" >&2
		exit 1
		;;
esac
