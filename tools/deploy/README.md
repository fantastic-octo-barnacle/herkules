# tools/deploy — running herkules

One HK VPS (2 vCPU / 4 GB), Docker Compose, one container per service, one
platform origin plus the bbs, status and ops subdomains. Four containers serve
traffic: `caddy`, `auth`, `bbs` and `postgres`, plus `bbs-worker` (the crawler),
`backup`, and the monitoring trio `gatus`, `beszel`, `beszel-agent` (see
"Monitoring"). Images are built by GitHub Actions and pulled by the box; the box
holds only `~/herkules/{docker-compose.yml, Caddyfile, gatus.yaml,
caddy/services/, .env, .env.auth, .env.backup, import/}` and its volumes
(`pgdata`, `avatars`, `caddy_data`, `caddy_config`, `gatus_data`, `beszel_*`).

The edge Caddy is **our image**, not the stock one: `services/web`'s SPA is baked
into it at `/srv` and served straight off disk, so there is no separate web
container. The Caddyfile is still bind-mounted, so a routing change is `scp` +
`up -d`; a Caddy version bump is a Dockerfile edit plus a deploy.

```
                 :443  ┌──────── caddy (edge, TLS + SPA) ──────┐
  browsers, IDEs ─────►│ herkules.dev                           │
                       │   /auth/*, /.well-known/*  → auth      │
                       │   /mcp/bbs*                → bbs       │
                       │   /*                       → /srv      │
                       │ bbs.herkules.dev/*         → bbs       │
                       │ status.herkules.dev/*      → gatus     │
                       │ ops.herkules.dev/*         → beszel    │  ◄── team NUCs/Jetsons (agents, WebSocket)
                       └────────────────────────────────────────┘
                   auth, bbs ──► postgres (herkules, bbs) ◄── backup (03:00 HKT pg_dump → R2)
                   bbs ──► auth (JWKS, token, user-info; in-network)
```

## One-time setup

1. **GitHub OAuth apps** — one per environment (Settings → Developer settings →
   OAuth Apps). Callback URL `https://herkules.dev/auth/callback/github`
   (prod) / `http://localhost:3000/auth/callback/github` (dev). The auth
   service asks for `read:org` itself.
2. **DNS** — A records for `herkules.dev`, `bbs.herkules.dev`,
   `status.herkules.dev` and `ops.herkules.dev` to the box, DNS-only (Caddy
   issues the certificates; a proxy in front would break TLS-ALPN/HTTP
   challenges and the IDE flows' `Origin` checks). `dns.sh` upserts all four
   idempotently with a token scoped to _Edit zone DNS_ on the one zone:
   ```sh
   CLOUDFLARE_API_TOKEN=… tools/deploy/dns.sh 124.156.183.221
   ```
3. **R2** — a bucket and an API token with object read/write; the endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
4. **The box** — Docker Engine with Compose v2.24+ (`!override` in the dev
   overlay needs it; prod does not). A deploy user in the `docker` group with
   the Actions public key in `~/.ssh/authorized_keys`.
   ```sh
   mkdir -p ~/herkules && cd ~/herkules
   ```
   Then create **three** env files from the blocks documented in
   `tools/deploy/.env.example`: `.env` (compose interpolation only), `.env.auth`
   (the auth container's `env_file`) and `.env.backup` (the R2 credentials). Only
   `.env` is read by compose itself, so a missing `.env.auth` or `.env.backup`
   fails at `up`, not at `config`. The split keeps the R2 keys and
   `BBS_COOKIE_SECRET` out of the auth container; `BBS_ORIGIN` and
   `BBS_CLIENT_SECRET` are deliberately in two files with the same value.
   The deploy job never touches these files — the box owns them.
5. **Repository secrets** (environment `production`): `DEPLOY_HOST`,
   `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key, PEM), `DEPLOY_KNOWN_HOSTS`
   (`ssh-keyscan -H <host>` output). The images are private: the deploy job
   logs the box into ghcr.io with its run token before pulling. For a manual
   `docker compose pull` on the box, `docker login ghcr.io` with a
   `read:packages` token first.

## Deploy

Push to `main` and wait for CI. `.github/workflows/images.yml` no longer runs on
the push itself: it triggers on `ci.yml` completing successfully for that commit
(`workflow_run`), so a red build never reaches the box. It then builds `auth`,
`bbs`, `caddy`, and `backup` for `linux/amd64`, pushes
`ghcr.io/<owner>/herkules/<name>:latest` (+ `sha-…`, + tags for `v*`), and over
SSH copies the compose files and runs
`docker compose pull && docker compose up -d --remove-orphans`.
A `v*` tag builds directly (CI does not run on tags) and does not deploy.

By hand on the box:

```sh
cd ~/herkules
docker compose pull && docker compose up -d --remove-orphans
docker compose ps            # every service healthy/running
docker compose logs -f auth  # migrations run at boot; "listening on :3001"
```

Roll back: `IMAGE_TAG=sha-<short> docker compose up -d` (or set it in `.env`).

## Verify

```sh
curl -fsS https://herkules.dev/auth/healthz                      # {"ok":true}
curl -fsS https://herkules.dev/.well-known/oauth-authorization-server/auth | head -c 300
curl -fsS https://herkules.dev/ | head -c 200                     # the SPA
```

## bbs (RM 文库)

One image, three commands (see `apps/bbs/README.md`), two long-running containers: `bbs`
(API + MCP + SPA) and `bbs-worker` (the crawler, `replicas: 1` since the 2026-08-28 cutover;
`--scale bbs-worker=0` pauses it). The crawl policy is constants in the code, not env: 2 s
spacing, 20/min, 2 000/day (UTC), 200 kept for reader-triggered refreshes, cooldown ladder on
429/403/5xx.

**Migrations run inside `bbs` at boot.** Before it listens it creates the database with
`ensureDatabase` (set `BBS_CREATE_DATABASE=false` and `createdb -U herkules bbs` yourself if the
role ever loses CREATEDB), applies `apps/bbs/drizzle`, and rederives derived columns when
`corpus_versions` differs. The image HEALTHCHECK on `:3003` therefore doubles as the "schema is
in" signal, which is what `bbs-worker` waits for. There is no `bbs-migrate` one-shot any more.
Accepted trade-off, 2026-08-28: a failed migration now crash-loops `bbs` instead of blocking the
rollout with the old container still serving. Run one by hand with
`docker compose run --rm bbs migrate` (idempotent; also the way to see the migration log without
starting a server).

**Self-host from an empty database** — nothing to import; the worker discovers page 1 every
10 min and backfills one page per ladder step until the forum is exhausted:

```sh
docker compose up -d --scale bbs-worker=1
docker compose run --rm bbs work --once                # one manual cycle; prints the counters
docker compose logs -f bbs-worker
```

**Cutover from the Singapore rm-wenku box** (its 908 generated overviews come only through a
final import; articles crawled afterwards show 尚未生成 until an AI phase exists):

1. From this box, `curl` both forum endpoints with rm-wenku's UA once; a 403 here is the kill criterion.
2. Deploy with `bbs-worker` at scale 0 (`replicas: 0` in the compose file).
3. Stop the old crawler, run `wenku backup` there, `scp` the dump, then the final import below.
4. Set `replicas: 1` in `docker-compose.yml` and redeploy (a bare `--scale bbs-worker=1` is undone by
   the next Actions deploy); a new forum post appears on the site within 15 min.
5. After a clean week, decommission the old box. A second worker against the same database exits 3
   (advisory lock) before sending any request — `compose ps` shows it restarting; harmless.

`bbs import` is DEPRECATED (the cutover tool and dev loader): it truncates the corpus,
including everything the worker wrote, and reloads from a `wenku backup` copy of the old box's SQLite:

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

After every successful upload `backup.sh` pings the status page's **Backups**
row (`GATUS_URL` + `GATUS_BACKUP_TOKEN`); 26 h of silence turns it red. The
monitoring volumes themselves (`gatus_data`, `beszel_data`) are not backed up:
the hub's settings are re-created from the section below in minutes.

## Monitoring

Two hosts, both served by the edge Caddy from the same compose file:

- **`https://status.herkules.dev`** — Gatus, public. Eight rows in `gatus.yaml`,
  one per thing somebody would act on: Site (+ certificate), Sign-in (the AS
  metadata document), RM 文库 Web / API & database / Crawler (`/api/status`,
  `crawler.lastCheckedAgeSeconds < 1800`) / MCP (the 401 challenge), Backups
  (pushed by `backup.sh`), Monitoring (the hub). Editing `gatus.yaml` is a push;
  on the box: `docker compose up -d --no-deps --force-recreate gatus`.
- **`https://ops.herkules.dev`** — the Beszel hub: metrics for this box and for
  every team machine (NUCs, Jetsons, servers), which dial in over WebSocket.
  Sign-in is the herkules auth service, so org membership is the access
  control; password login is off; `/_/` (PocketBase's superuser UI) is blocked
  at the edge.

Decisions that bind (framed 2026-08-28, built 2026-08-29):

- Monitoring lives in this one compose file and ships with the same deploy job;
  no ops overlay, no hand-managed services on the box.
- The hub's only gate is the herkules OIDC sign-in: no edge `basic_auth` or
  `forward_auth` (either would break the agents' handshake), no GitHub OAuth
  configured inside PocketBase. `services/auth` seeds the `beszel` client from
  `OPS_ORIGIN` + `BESZEL_CLIENT_SECRET`; `tests/oidc-client.test.ts` is the
  contract PocketBase relies on (`sub`, `email`, `email_verified`).
- Eight status rows, no more: one per thing somebody would act on. The forum
  itself is never probed (the crawler row already reports it, and extra
  requests risk the 403 kill criterion). Gatus cannot diff timestamps, which is
  why `/api/status` carries `crawler.lastCheckedAgeSeconds`.
- Fleet agents dial out with one universal token; `minipc-deploy`'s
  `beszel_agent` role owns the NUCs, the snippet below covers everything else.
- Monitoring data is not backed up; nothing here alerts anyone yet.

No alerting channel is configured (the team has not picked one). The external
"is the box dead" check is Better Stack Free, set up by hand (below).

### Hub first run

1. `.env`: `STATUS_HOST`, `OPS_HOST`, `GATUS_BACKUP_TOKEN`; `.env.auth`:
   `OPS_ORIGIN=https://ops.herkules.dev` and a `BESZEL_CLIENT_SECRET`. Deploy
   (auth re-seeds its clients at boot and logs `beszel` as seeded).
2. Create the PocketBase superuser (break-glass account, password manager) and
   open `/_/` through a tunnel — it is blocked at the edge, never over the internet:
   ```sh
   docker compose exec beszel /beszel superuser upsert <email> '<password>'
   ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' herkules-beszel-1)
   # from the laptop:  ssh -L 8090:$ip:8090 <box>   →   http://127.0.0.1:8090/_/
   ```
3. In `/_/` → Collections → `users` → Options → OAuth2: add provider **OpenID
   Connect** with client id `beszel`, the `BESZEL_CLIENT_SECRET`, and
   - Auth URL `https://herkules.dev/auth/oauth2/authorize`
   - Token URL `https://herkules.dev/auth/oauth2/token`
   - User info URL `https://herkules.dev/auth/oauth2/userinfo`
   - Display name `herkules`, PKCE on.
     Every org member who signs in now gets an account (`USER_CREATION=true`) with
     role `user`. **Flip each new member to `readonly`** in Users → role: with
     `SHARE_ALL_SYSTEMS=true` everyone sees every system, and `readonly` keeps a
     teammate from deleting one.
4. Sign in yourself at `https://ops.herkules.dev` (this creates your account),
   then promote it to `admin` in `/_/` → users.
5. This box's agent: copy the hub's public key (Add system dialog, or
   `docker compose exec beszel cat /beszel_data/id_ed25519.pub`) into `.env`
   as `BESZEL_KEY`, `docker compose up -d beszel-agent`, then **Add system** in
   the hub with host `/beszel_socket/beszel.sock`, name `herkules-hk`.
6. Settings → Tokens: enable the **universal token** and put it in the team
   password manager. Every fleet agent registers itself with it.
7. Optional dead-man switch: in Better Stack (free) create an HTTP monitor on
   `https://status.herkules.dev/` (email alert) and a **heartbeat** with a 2-min
   period / 5-min grace; put its URL in `.env` as `BESZEL_HEARTBEAT_URL` and
   `docker compose up -d beszel`.

### Enrolling a team machine

Agents dial out to the hub — no inbound port, works behind NAT and from
competition venues (`ALL_PROXY=socks5://…` if the venue needs a proxy).

- **NUCs provisioned by `minipc-deploy`**: the `beszel_agent` role does this in
  `converge.yml`; pass the universal token once:
  `rmctl host apply <name> --host-only --beszel-token-file ~/.rm/beszel.token`.
- **Jetsons and servers** (Ubuntu, arm64 or amd64), as root:
  ```sh
  curl -sL https://get.beszel.dev -o /tmp/install-agent.sh
  sh /tmp/install-agent.sh -url https://ops.herkules.dev -t <universal token> -k "<hub public key>"
  ```
  The hub's public key is shown in the Add system dialog. GPU stats need
  `nvidia-smi` on the path (Jetson: `tegrastats` is picked up automatically).
- The system appears in the hub under its hostname within a minute. Windows and
  macOS installs: <https://beszel.dev/guide/agent-installation>.

## Local stack (the same compose, built here)

```sh
cd tools/deploy
# .env, .env.auth and .env.backup, from the blocks in .env.example.
#   .env:       SITE_ADDRESS=http://localhost:3000, PUBLIC_ORIGIN=http://localhost:3000,
#               BBS_SITE_ADDRESS=http://localhost:3003, BBS_ORIGIN=http://localhost:3003,
#               any POSTGRES_PASSWORD; IMAGE_PREFIX can stay (the overlay builds locally)
#   .env.auth:  the dev GitHub app
#   .env.backup: may be empty — the backup service is scaled to 0 in the overlay
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Day-to-day development does not need Docker: `vp run dev` at the repository root
is one task (root `vite.config.ts`) that starts all four processes — `services/auth`
on `:3001` (PGlite), `services/web` on `:3000`, apps/bbs's Hono process on `:3103`
and apps/bbs's Vite SPA on `:3003`. The `:3000` server is the public origin and
proxies the others (`/mcp/bbs` to `:3103`); bbs's `:3003` server is its app origin.
Each package needs its own `.env` first; see that task's comment.

## Adding an MCP server

For a server that lives in this repository:

1. One line in `services/auth/src/registry.ts` (`RESOURCE_SPECS`).
2. A stage in the root `Dockerfile` — the `build` stage already installs and builds the whole
   workspace, so it is a runtime stage `FROM runtime AS <name>` plus its `COPY --from=build`.
3. `<name>` in the `target` matrix of `.github/workflows/images.yml`.
4. A service in `docker-compose.yml` using `${IMAGE_PREFIX}/<name>:${IMAGE_TAG:-latest}`, with
   `depends_on: postgres: service_healthy` and a `mem_limit` (the box has 4 GB).
5. `caddy/services/<name>.caddy`: `handle /mcp/<name>* { reverse_proxy <service>:<port> }`.
6. If it owns a database: add it to `DATABASES` on the `backup` service, and give it a
   `DATABASE_URL` built from `POSTGRES_PASSWORD`.
7. Its own env: compose-interpolated values go in `.env`; anything secret and container-specific
   gets its own `env_file` (`.env.<name>`), documented in `.env.example`.
8. Deploy. Its 401 challenge points at
   `/.well-known/oauth-protected-resource/mcp/<name>`, which auth now serves.

A server hosted in another repository skips steps 2 and 3 and points `image:` at its own registry.
