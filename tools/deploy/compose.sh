#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec docker compose \
  --project-directory "$root" \
  --env-file "$root/.env" \
  --env-file "$root/images.env" \
  -f "$root/docker-compose.yml" "$@"
