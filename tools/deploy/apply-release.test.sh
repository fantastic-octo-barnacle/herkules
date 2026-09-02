#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
root="$work/herkules"
fakebin="$work/bin"
mkdir -p "$root/incoming" "$fakebin"
cp "$(dirname "$0")/apply-release.sh" "$root/apply-release.sh"

cat > "$fakebin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *" ps") if [ "${FAIL_PS:-false}" = true ]; then exit 1; fi ;;
esac
exit 0
EOF
cat > "$fakebin/curl" <<'EOF'
#!/bin/sh
if [ "${FAIL_CURL:-false}" = true ]; then exit 22; fi
exit 0
EOF
chmod +x "$fakebin/docker" "$fakebin/curl"
printf 'POSTGRES_PASSWORD=test\n' > "$root/.env"
printf 'services:\n  legacy: {}\n' > "$root/docker-compose.yml"

make_bundle() {
  name=$1
  marker=$2
  bundle="$work/$name"
  mkdir -p "$bundle/caddy/services"
  printf '{"marker":"%s"}\n' "$marker" > "$bundle/release.json"
  printf 'AUTH_IMAGE_REF=%s\n' "$marker" > "$bundle/images.env"
  printf 'services: {}\n' > "$bundle/docker-compose.yml"
  printf '%s\n' "$marker" > "$bundle/Caddyfile"
  printf '%s\n' "$marker" > "$bundle/gatus.yaml"
  printf '%s\n' "$marker" > "$bundle/caddy/services/test.caddy"
  printf '#!/bin/sh\n' > "$bundle/compose.sh"
  cp "$(dirname "$0")/apply-release.sh" "$bundle/apply-release.sh"
  tar -czf "$root/incoming/$name.tar.gz" -C "$bundle" .
}

first_digest=$(printf 'a%.0s' $(seq 1 64))
second_digest=$(printf 'b%.0s' $(seq 1 64))
first_ref="ghcr.io/acme/herkules/release@sha256:$first_digest"
second_ref="ghcr.io/acme/herkules/release@sha256:$second_digest"
docker_log="$work/docker.log"
make_bundle first first
if DOCKER_LOG="$docker_log" FAIL_CURL=true PATH="$fakebin:$PATH" \
  sh "$root/apply-release.sh" first.tar.gz "$first_ref" none "caddy,gatus"; then
  echo "failed bootstrap unexpectedly succeeded" >&2
  exit 1
fi
test "$(sed -n '2p' "$root/docker-compose.yml")" = "  legacy: {}"
test ! -f "$root/current-release"
test ! -L "$root/active-config"

DOCKER_LOG="$docker_log" PATH="$fakebin:$PATH" \
  sh "$root/apply-release.sh" first.tar.gz "$first_ref" none "caddy,gatus"

test "$(sed -n '1p' "$root/current-release")" = "$first_ref"
test "$(sed -n '1p' "$root/images.env")" = "AUTH_IMAGE_REF=first"
test "$(sed -n '1p' "$root/active-config/Caddyfile")" = first
grep -q -- '--force-recreate caddy gatus' "$docker_log"

make_bundle second second
if DOCKER_LOG="$docker_log" FAIL_PS=true PATH="$fakebin:$PATH" \
  sh "$root/apply-release.sh" second.tar.gz "$second_ref" "$first_ref" "caddy"; then
  echo "failed release unexpectedly succeeded" >&2
  exit 1
fi

test "$(sed -n '1p' "$root/current-release")" = "$first_ref"
test "$(sed -n '1p' "$root/images.env")" = "AUTH_IMAGE_REF=first"
test "$(sed -n '1p' "$root/active-config/Caddyfile")" = first

echo "release applicator tests passed"
