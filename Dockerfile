# syntax=docker/dockerfile:1.7
# One build, four images: --target auth | mcp-directory | web | backup.
# The build stage installs the whole workspace once; runtime images get only
# `pnpm deploy --prod` output (auth, mcp-directory) or static files (web).

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.24.0
WORKDIR /app

FROM base AS build
COPY . .
# --ignore-scripts: the root `prepare` (vp config) wires git hooks; nothing to build natively.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @herkules/auth-middleware run build \
 && pnpm --filter @herkules/auth run build \
 && pnpm --filter @herkules/mcp-directory run build \
 && pnpm --filter @herkules/web run build
RUN pnpm --filter @herkules/auth deploy --prod --legacy /out/auth \
 && pnpm --filter @herkules/mcp-directory deploy --prod --legacy /out/mcp-directory

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
