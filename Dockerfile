# syntax=docker/dockerfile:1.7
# One build, five images: --target auth | mcp-directory | bbs | web | backup.
# The build stage installs the whole workspace once; runtime images get only
# `pnpm deploy --prod` output (auth, mcp-directory, bbs) or static files (web).

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.24.0
WORKDIR /app

FROM base AS build
COPY . .
# --ignore-scripts: the root `prepare` (vp config) wires git hooks; nothing to build natively.
RUN pnpm install --frozen-lockfile --ignore-scripts
# Order is dependency order: the two libraries export dist/*.mjs, so they pack first.
RUN pnpm --filter @herkules/auth-middleware run build \
 && pnpm --filter @herkules/oauth-client run build \
 && pnpm --filter @herkules/auth run build \
 && pnpm --filter @herkules/mcp-directory run build \
 && pnpm --filter @herkules/bbs run build \
 && pnpm --filter @herkules/web run build
# bbs round 2: the SPA build (`vp build` -> apps/bbs/dist/client) is part of @herkules/bbs's `build` script; nothing to add here.
RUN pnpm --filter @herkules/auth deploy --prod --legacy /out/auth \
 && pnpm --filter @herkules/mcp-directory deploy --prod --legacy /out/mcp-directory \
 && pnpm --filter @herkules/bbs deploy --prod --legacy /out/bbs

# ── auth ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS auth
ENV NODE_ENV=production PORT=3001 MIGRATIONS_DIR=/app/drizzle AVATAR_DIR=/data/avatars
WORKDIR /app
COPY --from=build --chown=node:node /out/auth /app
RUN mkdir -p /data/avatars && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/auth/healthz || exit 1
CMD ["node", "dist/main.mjs"]

# ── mcp-directory ───────────────────────────────────────────────────────────
FROM node:24-alpine AS mcp-directory
ENV NODE_ENV=production PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /out/mcp-directory /app
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/mcp/directory/healthz || exit 1
CMD ["node", "dist/main.mjs"]

# ── bbs (API + MCP + SPA; `files` carries dist/ and drizzle/) ───────────────
FROM node:24-alpine AS bbs
ENV NODE_ENV=production PORT=3003 MIGRATIONS_DIR=/app/drizzle WEB_DIR=/app/dist/client
WORKDIR /app
COPY --from=build --chown=node:node /out/bbs /app
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
# ENTRYPOINT, not CMD: `docker compose run --rm bbs import /import/app.db` appends argv (main.ts dispatches).
ENTRYPOINT ["node", "dist/main.mjs"]

# ── web (static, served by its own Caddy behind the edge Caddy) ─────────────
FROM caddy:2.10-alpine AS web
COPY services/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/services/web/dist /srv
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

# ── backup (nightly pg_dump -> Cloudflare R2 via rclone) ────────────────────
FROM postgres:17-alpine AS backup
RUN apk add --no-cache rclone
COPY tools/deploy/backup/backup.sh /usr/local/bin/backup
COPY tools/deploy/backup/crontab /etc/crontabs/root
RUN chmod +x /usr/local/bin/backup
CMD ["crond", "-f", "-l", "2"]
