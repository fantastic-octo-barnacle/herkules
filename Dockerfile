# syntax=docker/dockerfile:1.7
# One build, four images: --target auth | bbs | caddy | backup.
# The build stage installs the whole workspace once; runtime images get only
# `pnpm deploy --prod` output (auth, bbs) or static files (caddy).

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.24.0
WORKDIR /app

FROM base AS build
COPY . .
# --ignore-scripts: the root `prepare` (vp config) wires git hooks; nothing to build natively.
RUN pnpm install --frozen-lockfile --ignore-scripts
# --sort is pnpm's topological order over the workspace dependency graph
# (auth-middleware -> oauth-client -> auth -> bbs -> web), so adding, renaming or deleting a
# package needs no edit here. Packages without a `build` script are skipped, not failed.
# bbs round 2: the SPA build (`vp build` -> apps/bbs/dist/client) is part of @herkules/bbs's `build` script.
RUN pnpm -r --sort run build
# --ignore-scripts again: `pnpm deploy` otherwise runs the root `prepare` (vp config), which wants git.
RUN pnpm --filter @herkules/auth deploy --prod --legacy --ignore-scripts /out/auth \
 && pnpm --filter @herkules/bbs deploy --prod --legacy --ignore-scripts /out/bbs

# ── runtime base for the two Node services ─────────────────────────────────
# auth and bbs differ only in port, env, entrypoint and the /out directory they copy.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

# ── auth ────────────────────────────────────────────────────────────────────
FROM runtime AS auth
ENV PORT=3001 MIGRATIONS_DIR=/app/drizzle AVATAR_DIR=/data/avatars
COPY --from=build --chown=node:node /out/auth /app
# The `avatars` named volume inherits this directory's ownership, so it has to exist and be
# node-owned in the image; only root can create it, hence the two USER lines.
USER root
RUN mkdir -p /data/avatars && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/auth/healthz || exit 1
CMD ["node", "dist/main.mjs"]

# ── bbs (API + MCP + SPA; `files` carries dist/ and drizzle/) ───────────────
FROM runtime AS bbs
ENV PORT=3003 MIGRATIONS_DIR=/app/drizzle WEB_DIR=/app/dist/client
COPY --from=build --chown=node:node /out/bbs /app
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
# ENTRYPOINT, not CMD: `docker compose run --rm bbs import /import/app.db` appends argv (main.ts dispatches).
ENTRYPOINT ["node", "dist/main.mjs"]

# ── caddy (the edge: TLS, routing, and services/web's SPA served from /srv) ─
FROM caddy:2.10-alpine AS caddy
# No Caddyfile in the image on purpose: the box bind-mounts ~/herkules/Caddyfile and
# ~/herkules/caddy/services/, so a routing change stays `scp` + `up -d` with no rebuild.
# (Ports 80/443 and 443/udp are already EXPOSEd by the base image.)
COPY --from=build /app/services/web/dist /srv

# ── backup (nightly pg_dump -> Cloudflare R2 via rclone) ────────────────────
FROM rclone/rclone:1.72 AS rclone

FROM alpine:3.23 AS backup
RUN apk add --no-cache postgresql17-client
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY tools/deploy/backup/backup.sh /usr/local/bin/backup
COPY tools/deploy/backup/crontab /etc/crontabs/root
RUN chmod +x /usr/local/bin/backup
CMD ["crond", "-f", "-l", "2"]
