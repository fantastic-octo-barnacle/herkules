#!/bin/sh
set -eu

ready_file=/tmp/backup-preflight-ok
rm -f "$ready_file"
backup preflight
touch "$ready_file"
exec "$@"
