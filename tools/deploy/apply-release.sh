#!/bin/sh
set -eu

archive_name=${1:?release archive name is required}
release_ref=${2:?release OCI reference is required}
expected_current=${3:?expected current release or none is required}
recreate_csv=${4:-}
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

case "$archive_name" in
  *[!A-Za-z0-9._-]* | "") echo "invalid release archive name" >&2; exit 2 ;;
esac
validate_release_ref() {
  value=$1
  case "$value" in
    ghcr.io/*@sha256:*) ;;
    *) return 1 ;;
  esac
  value_digest=${value##*@sha256:}
  [ "${#value_digest}" -eq 64 ] || return 1
  case "$value_digest" in *[!0-9a-f]*) return 1 ;; esac
}
if ! validate_release_ref "$release_ref"; then
  echo "release must be an immutable ghcr.io reference" >&2
  exit 2
fi
if [ "$expected_current" != none ] && ! validate_release_ref "$expected_current"; then
  echo "expected current release is invalid" >&2
  exit 2
fi

archive="$root/incoming/$archive_name"
digest=${release_ref##*@sha256:}
release_dir="$root/releases/sha256-$digest"
current_file="$root/current-release"
actual_current=none
if [ -f "$current_file" ]; then actual_current=$(sed -n '1p' "$current_file"); fi
if [ "$actual_current" != "$expected_current" ]; then
  echo "production drifted: expected $expected_current, found $actual_current" >&2
  exit 1
fi

# Everything the applicator creates while working is removed on exit, whatever the outcome:
# the extraction directory, the rollback snapshot and the delivered archive (the bundle stays
# addressable in GHCR by digest).
incoming=""
backup=""
activated=false
had_previous=false
had_previous_config=false
had_previous_wrapper=false
finish() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$activated" = true ] && [ "$had_previous" = true ]; then
    restore_previous
  fi
  if [ -n "$incoming" ]; then rm -rf "$incoming"; fi
  if [ -n "$backup" ]; then rm -rf "$backup"; fi
  rm -f "$archive"
  exit "$status"
}
# A signal trap sees the status of the last completed command, which may be 0; pass the
# conventional signal status explicitly so an interrupted rollout is always restored.
trap finish EXIT
trap 'finish 129' HUP
trap 'finish 130' INT
trap 'finish 143' TERM

mkdir -p "$root/releases"
if [ ! -d "$release_dir" ]; then
  if [ ! -f "$archive" ]; then echo "release archive not found: $archive" >&2; exit 1; fi
  # Only regular files and directories, all inside the bundle: no absolute or parent paths, and
  # no symlinks or device nodes that could point a bind mount at a host path.
  if tar -tzf "$archive" | grep -Eq '^/|(^|/)\.\.(/|$)'; then
    echo "release archive contains paths outside the bundle" >&2
    exit 1
  fi
  if tar -tvzf "$archive" | grep -Evq '^[-d]'; then
    echo "release archive contains entries that are not regular files or directories" >&2
    exit 1
  fi
  incoming="$root/releases/.incoming-sha256-$digest-$$"
  rm -rf "$incoming"
  mkdir "$incoming"
  tar -xzf "$archive" -C "$incoming"
  for required in release.json images.env docker-compose.yml Caddyfile gatus.yaml apply-release.sh compose.sh; do
    if [ ! -f "$incoming/$required" ]; then
      echo "release bundle has no $required" >&2
      exit 1
    fi
  done
  if [ ! -d "$incoming/caddy/services" ]; then
    echo "release bundle has no caddy/services" >&2
    exit 1
  fi
  mv "$incoming" "$release_dir"
  incoming=""
fi

# Validate the candidate with its own image and mounts before changing the active release.
# run does not publish ports or start dependencies; the existing edge keeps serving.
candidate_compose() {
  DEPLOY_CONFIG_DIR="$release_dir" docker compose \
    --project-directory "$root" \
    --env-file "$root/.env" \
    --env-file "$release_dir/images.env" \
    -f "$release_dir/docker-compose.yml" "$@"
}
candidate_compose config --quiet
candidate_compose pull --quiet caddy
candidate_compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

backup="$root/releases/.previous-$$"
rm -rf "$backup"
mkdir "$backup"
if [ -f "$root/docker-compose.yml" ]; then
  cp "$root/docker-compose.yml" "$backup/docker-compose.yml"
  if [ -f "$root/images.env" ]; then cp "$root/images.env" "$backup/images.env"; else : > "$backup/images.env"; fi
  if [ -f "$root/compose.sh" ]; then
    cp "$root/compose.sh" "$backup/compose.sh"
    had_previous_wrapper=true
  fi
  if [ -L "$root/active-config" ]; then
    readlink "$root/active-config" > "$backup/active-config"
    had_previous_config=true
  fi
  had_previous=true
fi

compose() {
  docker compose \
    --project-directory "$root" \
    --env-file "$root/.env" \
    --env-file "$root/images.env" \
    -f "$root/docker-compose.yml" "$@"
}

restore_previous() {
  echo "release failed; restoring previous stack" >&2
  cp "$backup/docker-compose.yml" "$root/docker-compose.yml"
  cp "$backup/images.env" "$root/images.env"
  if [ "$had_previous_wrapper" = true ]; then
    cp "$backup/compose.sh" "$root/compose.sh"
  else
    unlink "$root/compose.sh" 2>/dev/null || true
  fi
  if [ "$had_previous_config" = true ]; then
    old_config=$(sed -n '1p' "$backup/active-config")
    ln -sfn "$old_config" "$root/active-config"
  else
    unlink "$root/active-config" 2>/dev/null || true
  fi
  compose pull --quiet || true
  compose up -d --remove-orphans --wait --wait-timeout 180 || true
  if [ -n "$recreate_csv" ]; then
    recreate=$(printf '%s' "$recreate_csv" | tr ',' ' ')
    # shellcheck disable=SC2086 # service names are validated by the release planner.
    compose up -d --no-deps --force-recreate $recreate || true
  fi
}

cp "$release_dir/docker-compose.yml" "$root/.docker-compose.yml.next"
cp "$release_dir/images.env" "$root/.images.env.next"
cp "$release_dir/compose.sh" "$root/.compose.sh.next"
mv "$root/.docker-compose.yml.next" "$root/docker-compose.yml"
mv "$root/.images.env.next" "$root/images.env"
mv "$root/.compose.sh.next" "$root/compose.sh"
ln -sfn "$release_dir" "$root/active-config"
activated=true

compose config --quiet
compose pull --quiet
compose up -d --remove-orphans --wait --wait-timeout 180
if [ -n "$recreate_csv" ]; then
  recreate=$(printf '%s' "$recreate_csv" | tr ',' ' ')
  # shellcheck disable=SC2086 # service names are validated by the release planner.
  compose up -d --no-deps --force-recreate $recreate
fi

curl -fsS --retry 5 --retry-delay 5 --retry-all-errors https://herkules.dev/auth/healthz >/dev/null
curl -fsS --retry 5 --retry-delay 5 --retry-all-errors https://herkules.dev/ >/dev/null
curl -fsS --retry 5 --retry-delay 5 --retry-all-errors https://bbs.herkules.dev/healthz >/dev/null
curl -fsS --retry 5 --retry-delay 5 --retry-all-errors https://status.herkules.dev/api/v1/endpoints/statuses >/dev/null

compose ps
printf '%s\n' "$release_ref" > "$root/.current-release.next"
mv "$root/.current-release.next" "$current_file"
# Digest-pinned images are never dangling, so only -a reclaims superseded releases. Rollback
# re-pulls whatever it needs by digest.
docker image prune -af >/dev/null || true
