#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
work=$(mktemp -d)
image="herkules-caddy-tls-test:$$"
trap 'rm -rf "$work"; docker image rm "$image" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker build --target caddy-tls -t "$image" "$root" >/dev/null
# Verify the image still starts the server when Compose supplies no command.
[ "$(docker image inspect "$image" --format '{{json .Config.Cmd}}')" = '["caddy","run","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"]' ]
mkdir "$work/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=herkules.dev \
  -addext 'subjectAltName=DNS:herkules.dev,DNS:*.herkules.dev' \
  -keyout "$work/good.key" -out "$work/good.pem" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=wrong.example \
  -keyout "$work/wrong.key" -out "$work/wrong.pem" 2>/dev/null
# Explicit dates work with both OpenSSL 3.0 (CI) and newer local versions.
: > "$work/index"
printf '01\n' > "$work/serial"
cat > "$work/ca.cnf" <<CONF
[ca]
default_ca = test
[test]
database = $work/index
serial = $work/serial
new_certs_dir = $work
certificate = $work/good.pem
private_key = $work/good.key
default_md = sha256
policy = policy
copy_extensions = copy
[policy]
commonName = supplied
CONF
openssl req -new -key "$work/good.key" -subj /CN=herkules.dev \
  -addext 'subjectAltName=DNS:herkules.dev,DNS:*.herkules.dev' -out "$work/request.pem"
openssl ca -batch -notext -config "$work/ca.cnf" -in "$work/request.pem" \
  -startdate 20200101000000Z -enddate 20200102000000Z -out "$work/expired.pem" 2>/dev/null
# A separate subject avoids the test CA's duplicate-subject restriction.
openssl req -new -key "$work/good.key" -subj /CN=future.herkules.dev \
  -addext 'subjectAltName=DNS:herkules.dev,DNS:*.herkules.dev' -out "$work/future-request.pem"
openssl ca -batch -notext -config "$work/ca.cnf" -in "$work/future-request.pem" \
  -startdate 20490101000000Z -enddate 20490102000000Z -out "$work/future.pem" 2>/dev/null
cert_fixture=
key_fixture=
run() {
  if [ -n "$cert_fixture" ]; then set -- -v "$cert_fixture:/run/origin-tls/origin.pem:ro" "$@"; fi
  if [ -n "$key_fixture" ]; then set -- -v "$key_fixture:/run/origin-tls/origin.key:ro" "$@"; fi
  docker run --rm \
    -v "$root/tools/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$root/tools/deploy/caddy/services:/etc/caddy/services:ro" \
    -e SITE_ADDRESS=herkules.dev -e BBS_SITE_ADDRESS=bbs.herkules.dev \
    -e STATUS_HOST=status.herkules.dev -e OPS_HOST=ops.herkules.dev \
    "$@" "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/log" 2>&1
}
reject() {
  if run; then echo "invalid TLS accepted: $1" >&2; exit 1; fi
  grep -q "$1" "$work/log" || { cat "$work/log"; exit 1; }
}
reject 'required certificate'
cert_fixture="$work/good.pem"
reject 'required private key'
key_fixture="$work/wrong.key"
reject 'do not match'
cert_fixture="$work/wrong.pem"
reject 'does not cover'
cert_fixture="$work/expired.pem"
key_fixture="$work/good.key"
reject 'expired'
cert_fixture="$work/future.pem"
reject 'not yet valid'
printf 'invalid PEM\n' > "$work/invalid.pem"
cert_fixture="$work/invalid.pem"
reject 'invalid PEM'
cert_fixture="$work/good.pem"
run || { cat "$work/log"; exit 1; }
cert_fixture=
key_fixture=
run -e CADDY_TLS_MODE=local_http -e SITE_ADDRESS=http://localhost:3000 \
  -e BBS_SITE_ADDRESS=http://localhost:3003 -e STATUS_HOST=http://status.localhost \
  -e OPS_HOST=http://ops.localhost -e AI_HOST=http://ai.localhost \
  -e AI_PORTAL_HOST=http://ai-portal.localhost || { cat "$work/log"; exit 1; }
if run -e CADDY_TLS_MODE=local_http; then echo 'local mode accepted production hosts' >&2; exit 1; fi
echo 'Caddy TLS container tests passed'
