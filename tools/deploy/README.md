# tools/deploy — running herkules

One HK VPS (2 vCPU / 4 GB), Docker Compose, one container per service, one
platform origin plus the bbs, status and ops subdomains. Four containers serve
traffic: `caddy`, `auth`, `bbs` and `postgres`, plus `bbs-worker` (the crawler), `bbs-bot`,
`backup`, and the monitoring trio `gatus`, `beszel`, `beszel-agent` (see
"Monitoring"). GitHub Actions builds images and complete OCI release bundles in
GHCR, then applies an exact release digest to the box. The box keeps
`~/herkules/{docker-compose.yml,images.env,compose.sh,current-release,active-config,
releases/,incoming/}`, the four server-owned env files, `import/`, and its volumes
(`pgdata`, `avatars`, `caddy_data`, `caddy_config`, `gatus_data`, `beszel_*`).

The edge Caddy is **our image**, not the stock one: `services/web`'s SPA is baked
into it at `/srv` and served straight off disk, so there is no separate web
container. Caddy configuration remains bind-mounted from the active release. The
release applicator recreates Caddy when that configuration digest changes.

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
   challenges and the IDE flows' `Origin` checks). The box has no IPv6: A
   records only, no AAAA.
3. **R2** — a bucket and an API token with object read/write; the endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
4. **The box** — Docker Engine with Compose v2.24+ (`!override` in the dev
   overlay needs it; prod does not). A deploy user in the `docker` group with
   the Actions public key in `~/.ssh/authorized_keys`.
   ```sh
   mkdir -p ~/herkules && cd ~/herkules
   ```
   Then create **four** env files from the blocks documented in
   `tools/deploy/.env.example`: `.env` (compose interpolation only), `.env.auth`, `.env.bot`
   (the Feishu app credentials), and `.env.backup` (the R2 credentials). Only
   `.env` is read by compose itself, so a missing `.env.auth`, `.env.bot`, or `.env.backup`
   fails at `up`, not at `config`. The split keeps the R2 keys and
   `BBS_COOKIE_SECRET` out of the auth container; `BBS_ORIGIN` and
   `BBS_CLIENT_SECRET` are deliberately in two files with the same value.
   The deploy job never touches these files — the box owns them.
5. **Repository secrets** (environment `production`): `DEPLOY_HOST`,
   `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key, PEM), `DEPLOY_KNOWN_HOSTS`
   (`ssh-keyscan -H <host>` output). The images are private: the deploy job
   logs the box into ghcr.io with its run token before pulling. For a manual
   `sh compose.sh pull` on the box, `docker login ghcr.io` with a
   `read:packages` token first.

## Deploy

Push to `main` and wait for CI. `images.yml` runs only after that commit's `CI`
workflow succeeds. It diffs the commit against the source of the active
production release and builds the affected `linux/amd64` images, so a failed
release is retried by the next push whether or not that push touches the same
files. A manual run rebuilds all four. A CI run that finishes after a newer
commit has already been released is skipped.

Every built image gets a readable `sha-<commit>` tag. The build digest is the
version used in production. The serialized release job reads the latest successful
Herkules GitHub Deployment, retains its unchanged image digests, and publishes a
complete OCI release bundle at `ghcr.io/<owner>/herkules/release`. The bundle
contains `release.json`, `images.env`, Compose, Caddy and Gatus configuration, and
the release scripts. It then applies that exact release digest over SSH. Mutable
`latest` tags are never deployment inputs.

The box records the active OCI reference in `current-release`. The applicator
checks it against the GitHub Deployment before changing anything, restores the
previous release if rollout or public verification fails, and changes
`current-release` only after success. Documentation and standalone exporter
changes do not deploy. Runtime configuration can deploy without rebuilding an
image.

By hand on the box:

```sh
cd ~/herkules
sh compose.sh pull && sh compose.sh up -d --remove-orphans
sh compose.sh ps            # every service healthy/running
sh compose.sh logs -f auth  # migrations run at boot; "listening on :3001"
```

Roll back from GitHub Actions with **Rollback production**. Select `full` to
activate a previous OCI bundle, or `component` to copy one image digest from a
previous release into the currently active bundle. Identify the source release
with its GitHub Deployment ID or full source SHA, then type
`rollback-production`. Both modes create a new successful Deployment record, and
the next push to `main` diffs against that record's source. A full rollback
carries the older commit's source, so the next push rebuilds everything that
changed since it and the rollback lasts until then. A component rollback keeps
the current source, so the restored image stays until its inputs change. Normal
and rollback deployments share the `deploy-production` concurrency group.

Full rollback restores images and deployment configuration. Component rollback
retains the current configuration and changes one image. Neither mode reverses
database migrations, so an older image must remain compatible with the current
schema. Do not edit `images.env`, `current-release`, or deployment files on the
box by hand; use the workflow so production and GitHub retain the same state.

## Verify

```sh
curl -fsS https://herkules.dev/auth/healthz                      # {"ok":true}
curl -fsS https://herkules.dev/.well-known/oauth-authorization-server/auth | head -c 300
curl -fsS https://herkules.dev/ | head -c 200                     # the SPA
```

## bbs (RM 文库)

One image, six commands (see `apps/bbs/README.md`), with separate long-running `bbs`,
`bbs-worker`, and `bbs-bot` containers. The crawler has `replicas: 1` since the 2026-08-28
cutover; `--scale bbs-worker=0` pauses it. The crawl policy is constants in the code, not env: 2 s
spacing, 20/min, 2 000/day (UTC), 200 kept for reader-triggered refreshes, cooldown ladder on
429/403/5xx.

**Migrations run inside `bbs` at boot.** Before it listens it creates the database with
`ensureDatabase` (set `BBS_CREATE_DATABASE=false` and `createdb -U herkules bbs` yourself if the
role ever loses CREATEDB), applies `apps/bbs/drizzle`, and rederives derived columns when
`corpus_versions` differs. The image HEALTHCHECK on `:3003` therefore doubles as the "schema is
in" signal, which is what `bbs-worker` waits for. There is no `bbs-migrate` one-shot any more.
Accepted trade-off, 2026-08-28: a failed migration now crash-loops `bbs` instead of blocking the
rollout with the old container still serving. Run one by hand with
`sh compose.sh run --rm bbs migrate` (idempotent; also the way to see the migration log without
starting a server).

**Self-host from an empty database** — nothing to import; the worker discovers page 1 every
10 min and backfills one page per ladder step until the forum is exhausted:

```sh
sh compose.sh up -d --scale bbs-worker=1
sh compose.sh run --rm bbs work --once                # one manual cycle; prints the counters
sh compose.sh logs -f bbs-worker
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
sh compose.sh run --rm bbs import /import/app.db     # prints the per-table report; exit 0 = verified
sh compose.sh run --rm bbs import /import/app.db     # same dump again -> "no-op"
curl -fsS https://bbs.herkules.dev/api/status
curl -sI  https://herkules.dev/mcp/bbs | grep -i www-authenticate   # 401 + resource_metadata for /mcp/bbs
```

The bbs container reaches auth in-network (`AUTH_INTERNAL_URL`), presents
`BBS_CLIENT_SECRET` (the same value auth seeds the confidential `bbs` client
from) and seals its session cookie with `BBS_COOKIE_SECRET`.

### Feishu bot

Create and publish an internal self-built Feishu app, enable its bot capability, and subscribe to
`im.message.receive_v1` using WebSocket delivery. Grant the app permission to receive and send
messages, add it to the announcement group, and put its app ID, secret, and the group's `oc_...`
chat ID in `.env.bot` as shown in `.env.example`. No Caddy route or public callback is needed.

Start it after the normal BBS container has migrated:

```sh
sh compose.sh up -d bbs-bot
sh compose.sh logs -f bbs-bot
```

The first successful WebSocket connection activates notifications and baselines every article
already in the database. Confirm one mentioned group search and one ordinary direct-message search
before relying on announcements. If either event type does not arrive through the long connection,
stop the bot and reassess the tenant setup rather than adding a webhook fallback.

## Backups

The `backup` container runs `pg_dump --format=custom` at 03:00 HKT for each
database in `DATABASES` (`herkules bbs`), streams them to
`r2:<bucket>/herkules/<db>-<UTC stamp>.dump` and deletes dumps older than
`BACKUP_KEEP_DAYS`. Before cron starts, the container runs `backup preflight` once: it verifies
both databases can be dumped, then writes, reads and deletes `herkules/.preflight` in R2. A
successful result is cached in `/tmp/backup-preflight-ok` for the container health check, so normal
health probes do not consume R2 operations. Every new container performs a fresh preflight, and the
deployment waits for it to become healthy. The box continues to own `.env.backup`; do not copy its
R2 credentials into GitHub Actions.

Manual run and restore:

```sh
sh compose.sh run --rm backup backup
# restore into a fresh database (stop the owning service first; `bbs` for the bbs dump):
sh compose.sh stop auth
rclone copy r2:<bucket>/herkules/herkules-<stamp>.dump /tmp/
sh compose.sh exec -T postgres pg_restore --clean --if-exists -U herkules -d herkules < /tmp/herkules-<stamp>.dump
sh compose.sh start auth
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
  the deploy and rollback jobs force-recreate Gatus so it reads the changed bind mount. On
  the box, use `sh compose.sh up -d --no-deps --force-recreate gatus`.
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
   (auth re-seeds its clients at boot; an unauthenticated
   `/auth/oauth2/authorize?client_id=beszel&…` then redirects to `/login`
   instead of answering `invalid_client`).
2. Create the PocketBase superuser (break-glass account, password manager) and
   open `/_/` through a tunnel — it is blocked at the edge, never over the internet:
   ```sh
   sh compose.sh exec beszel /beszel superuser upsert <email> '<password>'
   ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' herkules-beszel-1)
   # from the laptop:  ssh -L 8090:$ip:8090 <box>   →   http://127.0.0.1:8090/_/
   ```
3. In `/_/` → Collections → `users` → Options → OAuth2: add provider **OpenID
   Connect** with client id `beszel`, the `BESZEL_CLIENT_SECRET`, and
   - Auth URL `https://herkules.dev/auth/oauth2/authorize`
   - Token URL `https://herkules.dev/auth/oauth2/token`
   - User info URL `https://herkules.dev/auth/oauth2/userinfo`
   - Display name `herkules`, PKCE on.
     The hub runs with `OAUTH_DISABLE_POPUP=true`, so sign-in uses a full-page redirect
     and returns to `https://ops.herkules.dev/`; browsers do not need popup permission.
     Every org member who signs in now gets an account (`USER_CREATION=true`) with
     role `user`. **Flip each new member to `readonly`** in Users → role: with
     `SHARE_ALL_SYSTEMS=true` everyone sees every system, and `readonly` keeps a
     teammate from deleting one.
4. Sign in yourself at `https://ops.herkules.dev` (this creates your account),
   then promote it to `admin` in `/_/` → users.
5. This box's agent: put the hub's public key into `.env` as `BESZEL_KEY` (the
   Add system dialog shows it; from the shell, derive it — the hub image is
   distroless and keeps only the private key):
   ```sh
   docker run --rm -v herkules_beszel_data:/d:ro alpine:3.23 sh -c \
     'apk add -q openssh-keygen && cp /d/id_ed25519 /tmp/k && chmod 600 /tmp/k && ssh-keygen -y -f /tmp/k'
   ```
   then `sh compose.sh up -d beszel-agent` (it restart-loops harmlessly while
   the key is empty), then **Add system** in the hub with host
   `/beszel_socket/beszel.sock`, name `herkules-hk`.
6. Settings → Tokens: enable the **universal token** and put it in the team
   password manager. Every fleet agent registers itself with it.
7. Optional dead-man switch: in Better Stack (free) create an HTTP monitor on
   `https://status.herkules.dev/` (email alert) and a **heartbeat** with a 2-min
   period / 5-min grace; put its URL in `.env` as `BESZEL_HEARTBEAT_URL` and
   `sh compose.sh up -d beszel`.

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
# .env, .env.auth, .env.bot and .env.backup, from the blocks in .env.example.
#   .env:       SITE_ADDRESS=http://localhost:3000, PUBLIC_ORIGIN=http://localhost:3000,
#               BBS_SITE_ADDRESS=http://localhost:3003, BBS_ORIGIN=http://localhost:3003,
#               any POSTGRES_PASSWORD; the four *_IMAGE_REF values can stay (the overlay builds locally)
#   .env.auth:  the dev GitHub app
#   .env.backup: may be empty — the backup service is scaled to 0 in the overlay
#   .env.bot: required by Compose, but bbs-bot is scaled to 0 in the overlay
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
3. `<name>` in `IMAGE_TARGETS` and the dependency map in `tools/deploy/image-targets.mjs`.
4. A service in `docker-compose.yml` using `${NAME_IMAGE_REF:?}`, with
   `depends_on: postgres: service_healthy` and a `mem_limit` (the box has 4 GB).
5. `caddy/services/<name>.caddy`: `handle /mcp/<name>* { reverse_proxy <service>:<port> }`.
6. If it owns a database: add it to `DATABASES` on the `backup` service, and give it a
   `DATABASE_URL` built from `POSTGRES_PASSWORD`.
7. Its own env: compose-interpolated values go in `.env`; anything secret and container-specific
   gets its own `env_file` (`.env.<name>`), documented in `.env.example`.
8. Deploy. Its 401 challenge points at
   `/.well-known/oauth-protected-resource/mcp/<name>`, which auth now serves.

A server hosted in another repository skips steps 2 and 3 and points `image:` at its own registry.
