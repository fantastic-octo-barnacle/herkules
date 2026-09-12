#!/bin/sh
set -eu

fail() { echo "Caddy origin TLS: $*" >&2; exit 1; }
case "${CADDY_TLS_MODE:-origin_tls}" in
  local_http)
    # Only the laptop Compose overlay selects this mode. Never silently downgrade production.
    for address in "${SITE_ADDRESS:-}" "${BBS_SITE_ADDRESS:-}" "${STATUS_HOST:-}" "${OPS_HOST:-}" "${AI_HOST:-http://ai.localhost}" "${AI_PORTAL_HOST:-http://ai-portal.localhost}"; do
      case "$address" in http://*) ;; *) fail "local mode requires explicit HTTP addresses" ;; esac
    done
    ;;
  origin_tls)
    cert=/run/origin-tls/origin.pem
    key=/run/origin-tls/origin.key
    [ -s "$cert" ] && [ -r "$cert" ] || fail "required certificate is missing or unreadable: $cert"
    [ -s "$key" ] && [ -r "$key" ] || fail "required private key is missing or unreadable: $key"
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT HUP INT TERM
    openssl x509 -in "$cert" -pubkey -noout > "$work/cert.pub" || fail "invalid PEM certificate"
    openssl pkey -in "$key" -passin pass: -pubout > "$work/key.pub" 2>/dev/null || fail "invalid or encrypted private key"
    cmp -s "$work/cert.pub" "$work/key.pub" || fail "certificate and private key do not match"
    for host in "${SITE_ADDRESS:-}" "${BBS_SITE_ADDRESS:-}" "${STATUS_HOST:-}" "${OPS_HOST:-}" "${AI_HOST:-ai.herkules.dev}" "${AI_PORTAL_HOST:-ai-portal.herkules.dev}"; do
      case "$host" in ""|*[!a-zA-Z0-9.-]*) fail "production addresses must be bare DNS hostnames" ;; esac
      # Trust the operator-provided leaf for this local check, not the system CA store:
      # Origin CA certificates are not publicly trusted. Check dates and every routed hostname.
      openssl verify -partial_chain -trusted "$cert" -verify_hostname "$host" "$cert" >/dev/null 2>&1 ||
        fail "certificate is expired, not yet valid, or does not cover $host"
    done
    rm -rf "$work"
    trap - EXIT HUP INT TERM
    ;;
  *) fail "unknown TLS mode" ;;
esac
exec "$@"
