#!/bin/sh
# Upsert DNS-only A records for every host this stack serves (Caddy issues the certificates,
# so nothing here may be proxied). Idempotent: unchanged records are reported, not rewritten.
#
#   CLOUDFLARE_API_TOKEN=... tools/deploy/dns.sh 124.156.183.221 [zone]
#
# Token: dash.cloudflare.com → My Profile → API Tokens → Create → "Edit zone DNS" template,
# scoped to the one zone. Needs curl + jq.
set -eu
ip=${1:?usage: dns.sh <box ip> [zone]}
zone=${2:-herkules.dev}
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Zone.DNS:Edit on $zone)}"
api=https://api.cloudflare.com/client/v4
cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

zone_id=$(cf "$api/zones?name=$zone" | jq -r '.result[0].id // empty')
[ -n "$zone_id" ] || { echo "dns: zone $zone not visible to this token" >&2; exit 1; }

for name in "$zone" "bbs.$zone" "status.$zone" "ops.$zone"; do
	existing=$(cf "$api/zones/$zone_id/dns_records?type=A&name=$name")
	id=$(echo "$existing" | jq -r '.result[0].id // empty')
	body=$(jq -nc --arg n "$name" --arg ip "$ip" '{type:"A",name:$n,content:$ip,ttl:1,proxied:false,comment:"herkules box (tools/deploy/dns.sh)"}')
	if [ -z "$id" ]; then
		cf -X POST "$api/zones/$zone_id/dns_records" --data "$body" >/dev/null
		echo "created  $name -> $ip"
	elif [ "$(echo "$existing" | jq -r '.result[0] | "\(.content) \(.proxied)"')" = "$ip false" ]; then
		echo "ok       $name -> $ip"
	else
		cf -X PUT "$api/zones/$zone_id/dns_records/$id" --data "$body" >/dev/null
		echo "updated  $name -> $ip (was $(echo "$existing" | jq -r '.result[0] | "\(.content) proxied=\(.proxied)"'))"
	fi
done
