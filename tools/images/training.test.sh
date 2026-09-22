#!/bin/sh
# Exercise the actual training route with public fixtures; no production services.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
work=$(mktemp -d)
container=
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$work/site/assets" "$work/site/labs"
printf '<h1>Training</h1>' > "$work/site/index.html"
printf '<h1>PID</h1>' > "$work/site/labs/pid.html"
printf '<h1>Not found</h1>' > "$work/site/404.html"
printf 'console.log("fixture")' > "$work/site/assets/demo.123.js"
cat > "$work/Caddyfile" <<'CADDY'
:80 {
 import /routes/training.caddy
}
CADDY
container=$(docker run -d --rm -p 127.0.0.1::80 \
  -v "$work/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$root/tools/images/caddy:/routes:ro" \
  -v "$work/site:/srv/training:ro" caddy:2.10-alpine)
port=$(docker port "$container" 80/tcp | sed 's/.*://')
node --input-type=module - "$port" <<'JS'
import assert from 'node:assert/strict';
const base = `http://127.0.0.1:${process.argv[2]}`;
for (let attempt = 0; ; attempt++) {
  try { await fetch(base); break; }
  catch (error) { if (attempt >= 40) throw error; await new Promise(r => setTimeout(r, 100)); }
}
for (const path of ['/', '/labs/pid', '/labs/pid.html']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-cache', path);
}
const asset = await fetch(base + '/assets/demo.123.js');
assert.equal(asset.status, 200);
assert.match(asset.headers.get('cache-control'), /immutable/);
for (const path of ['/missing', '/assets/missing.js']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 404, path);
  assert.equal(response.headers.get('cache-control'), 'no-cache', path);
  assert.match(await response.text(), /Not found/);
}
console.log('Training clean URLs, 404s and cache headers passed');
JS
