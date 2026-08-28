# tools/deploy — running herkules

One HK VPS (2 vCPU / 4 GB), Docker Compose, one container per service, one
platform origin plus the bbs subdomain. Images are built by GitHub Actions and
pulled by the box; the box holds only `~/herkules/{docker-compose.yml, Caddyfile,
caddy/services/, .env, import/}` and three volumes (`pgdata`, `avatars`, `caddy_data`).

```
                 :443  ┌──────── caddy (edge, TLS) ────────────┐
  browsers, IDEs ─────►│ herkules.dev                           │
                       │   /auth/*, /.well-known/*  → auth      │
                       │   /mcp/directory*          → mcp-dir   │
                       │   /mcp/bbs*                → bbs       │
                       │   /*                       → web       │
                       │ bbs.herkules.dev/*         → bbs       │
                       └────────────────────────────────────────┘
                   auth, bbs ──► postgres (herkules, bbs) ◄── backup (03:00 HKT pg_dump → R2)
                   mcp-directory, bbs ──► auth (JWKS, token, user-info; in-network)
```

## One-time setup

1. **GitHub OAuth apps** — one per environment (Settings → Developer settings →
   OAuth Apps). Callback URL `https://herkules.dev/auth/callback/github`
   (prod) / `http://localhost:3000/auth/callback/github` (dev). The auth
   service asks for `read:org` itself.
2. **DNS** — A/AAAA records for `herkules.dev` and `bbs.herkules.dev` to the
   box, DNS-only (Caddy issues the certificates; a proxy in front would break
   TLS-ALPN/HTTP challenges and the IDE flows' `Origin` checks).
3. **R2** — a bucket and an API token with object read/write; the endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
4. **The box** — Docker Engine with Compose v2.24+ (`!override` in the dev
   overlay needs it; prod does not). A deploy user in the `docker` group with
   the Actions public key in `~/.ssh/authorized_keys`.
   ```sh
   mkdir -p ~/herkules && cd ~/herkules
   # copy tools/deploy/.env.example here as .env and fill every blank
   ```
5. **Repository secrets** (environment `production`): `DEPLOY_HOST`,
   `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key, PEM), `DEPLOY_KNOWN_HOSTS`
   (`ssh-keyscan -H <host>` output). Images are public or the box must
   `docker login ghcr.io` once with a read token.

## Deploy

Push to `main`. `.github/workflows/images.yml` builds `auth`, `mcp-directory`,
`bbs`, `web`, `backup` for `linux/amd64`, pushes `ghcr.io/<owner>/herkules/<name>:latest`
(+ `sha-…`, + tags for `v*`), then over SSH copies the compose files and runs
`docker compose pull && docker compose up -d --remove-orphans`.

By hand on the box:

```sh
cd ~/herkules
docker compose pull && docker compose up -d --remove-orphans
docker compose ps            # every service healthy/running
docker compose logs -f auth  # migrations run at boot; "listening on :3001"
```

Roll back: `IMAGE_TAG=sha-<short> docker compose up -d` (or set it in `.env`).

## Verify (the FRAME done predicate, item 5 and the parts it enables)

```sh
curl -fsS https://herkules.dev/auth/healthz                      # {"ok":true}
curl -fsS https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory
curl -fsS https://herkules.dev/.well-known/oauth-authorization-server/auth | head -c 300
curl -sI  https://herkules.dev/mcp/directory | grep -i www-authenticate   # 401 + resource_metadata
curl -fsS https://herkules.dev/ | head -c 200                     # the SPA
```

Then the kill-criterion run: `claude mcp add --transport http directory https://herkules.dev/mcp/directory`,
`/mcp` → GitHub → consent → `whoami`; the same in VS Code.

## bbs (RM 文库)

`bbs` creates its database at boot (`ensureDatabase`; set `BBS_CREATE_DATABASE=false`
and `createdb -U herkules bbs` yourself if the role ever loses CREATEDB) and runs its
migrations, but serves an empty archive until the corpus is imported from a
`wenku backup` copy of the old box's SQLite:

```sh
scp old-box:app.db ~/herkules/import/app.db          # ./import is mounted read-only at /import
docker compose run --rm bbs import /import/app.db     # prints the per-table report; exit 0 = verified
docker compose run --rm bbs import /import/app.db     # same dump again -> "no-op"
curl -fsS https://bbs.herkules.dev/api/status
curl -sI  https://herkules.dev/mcp/bbs | grep -i www-authenticate   # 401 + resource_metadata for /mcp/bbs
```

The bbs container reaches auth in-network (`AUTH_INTERNAL_URL`), presents
`BBS_CLIENT_SECRET` (the same value auth seeds the confidential `bbs` client
from) and seals its session cookie with `BBS_COOKIE_SECRET`.

## Backups

The `backup` container runs `pg_dump --format=custom` at 03:00 HKT for each
database in `DATABASES` (`herkules bbs`), streams them to
`r2:<bucket>/herkules/<db>-<UTC stamp>.dump` and deletes dumps older than
`BACKUP_KEEP_DAYS`. Manual run and restore:

```sh
docker compose run --rm backup backup
# restore into a fresh database (stop the owning service first; `bbs` for the bbs dump):
docker compose stop auth
rclone copy r2:<bucket>/herkules/herkules-<stamp>.dump /tmp/
docker compose exec -T postgres pg_restore --clean --if-exists -U herkules -d herkules < /tmp/herkules-<stamp>.dump
docker compose start auth
```

The bbs corpus is also reproducible from the old box's `app.db`: a re-import
is a full replacement, so restoring its dump is only faster, never necessary.

Avatars (`avatars` volume) are a cache: lost avatars are re-fetched at the
user's next sign-in.

## Local stack (the same compose, built here)

```sh
cd tools/deploy
cp .env.example .env    # SITE_ADDRESS=http://localhost:3000, PUBLIC_ORIGIN=http://localhost:3000,
                        # BBS_SITE_ADDRESS=http://localhost:3003, BBS_ORIGIN=http://localhost:3003,
                        # the dev GitHub app, any POSTGRES_PASSWORD; IMAGE_PREFIX can stay
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Day-to-day development does not need Docker: `vp run dev` in `services/auth`
(PGlite), `services/mcp-directory`, `services/web` and `apps/bbs` — the Vite
server on `:3000` is the public origin and proxies the others (`/mcp/bbs` to
bbs's Hono process on `:3103`); bbs's own Vite server on `:3003` is its app origin.

## Adding an MCP server

1. One line in `services/auth/src/registry.ts` (`RESOURCE_SPECS`).
2. A service in `docker-compose.yml` (its image comes from its own repo).
3. `caddy/services/<name>.caddy`: `handle /mcp/<name>* { reverse_proxy <service>:<port> }`.
4. Deploy. Its 401 challenge points at
   `/.well-known/oauth-protected-resource/mcp/<name>`, which auth now serves.
