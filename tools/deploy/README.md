# tools/deploy — running herkules

One HK VPS (2 vCPU / 4 GB), Docker Compose, one container per service, one
origin. Images are built by GitHub Actions and pulled by the box; the box holds
only `~/herkules/{docker-compose.yml, Caddyfile, caddy/services/, .env}` and
three volumes (`pgdata`, `avatars`, `caddy_data`).

```
                 :443  ┌──────── caddy (edge, TLS) ────────┐
  browsers, IDEs ─────►│ /auth/*, /.well-known/*  → auth    │
                       │ /mcp/directory*          → mcp-dir │
                       │ /*                       → web     │
                       └────────────────────────────────────┘
                              auth ──► postgres ◄── backup (03:00 HKT pg_dump → R2)
                              mcp-directory ──► auth (JWKS, user-info; in-network)
```

## One-time setup

1. **GitHub OAuth apps** — one per environment (Settings → Developer settings →
   OAuth Apps). Callback URL `https://herkules.dev/auth/callback/github`
   (prod) / `http://localhost:3000/auth/callback/github` (dev). The auth
   service asks for `read:org` itself.
2. **DNS** — an A/AAAA record for `herkules.dev` to the box, DNS-only (Caddy
   issues the certificate; a proxy in front would break TLS-ALPN/HTTP
   challenges and the IDE flows' `Origin` checks).
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
`web`, `backup` for `linux/amd64`, pushes `ghcr.io/<owner>/herkules/<name>:latest`
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

## Backups

The `backup` container runs `pg_dump --format=custom` at 03:00 HKT, streams it
to `r2:<bucket>/herkules/auth-<UTC stamp>.dump` and deletes dumps older than
`BACKUP_KEEP_DAYS`. Manual run and restore:

```sh
docker compose run --rm backup backup
# restore into a fresh database (stop auth first):
docker compose stop auth
rclone copy r2:<bucket>/herkules/auth-<stamp>.dump /tmp/
docker compose exec -T postgres pg_restore --clean --if-exists -U herkules -d herkules < /tmp/auth-<stamp>.dump
docker compose start auth
```

Avatars (`avatars` volume) are a cache: lost avatars are re-fetched at the
user's next sign-in.

## Local stack (the same compose, built here)

```sh
cd tools/deploy
cp .env.example .env    # SITE_ADDRESS=http://localhost:3000, PUBLIC_ORIGIN=http://localhost:3000,
                        # the dev GitHub app, any POSTGRES_PASSWORD; IMAGE_PREFIX can stay
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Day-to-day development does not need Docker: `vp run dev` in `services/auth`
(PGlite), `services/mcp-directory` and `services/web` — the Vite server on
`:3000` is the public origin and proxies the other two.

## Adding an MCP server

1. One line in `services/auth/src/registry.ts` (`RESOURCE_SPECS`).
2. A service in `docker-compose.yml` (its image comes from its own repo).
3. `caddy/services/<name>.caddy`: `handle /mcp/<name>* { reverse_proxy <service>:<port> }`.
4. Deploy. Its 401 challenge points at
   `/.well-known/oauth-protected-resource/mcp/<name>`, which auth now serves.
