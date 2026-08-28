# RM 文库

`@herkules/bbs` is the archive and search application at `https://bbs.herkules.dev`. One Hono process serves the API, the MCP endpoint, browser OAuth routes, the built TanStack SPA, and page metadata. It stores the corpus in its own Postgres database. The crawler runs from the same image as a separate `bbs-worker` command.

The web UI has its own README, owned separately: [`web/README.md`](web/README.md).

## Run and test

Copy `.env.example` to `.env`, then:

```sh
vp run dev
vp run dev:web
vp test
vp check
vp run build
```

The config default is port 3003. The checked-in `.env.example` sets Hono to 3103 so the SPA dev server can own port 3003 and proxy through `web/vite.config.ts`. Deployment, worker startup, import, cutover, and backup commands live in [`../../tools/deploy/README.md`](../../tools/deploy/README.md).

## Ownership and identity

- BBS owns its database, corpus, API, MCP tools, crawl state, and search behavior. `services/auth` owns users and resource registration.
- `PUBLIC_ORIGIN` is the platform origin. It determines issuer and API/MCP audiences. `APP_ORIGIN` is the browser origin. It determines the OAuth callback, cookie, canonical URLs, and page metadata. `src/config.ts` is the boundary.
- Browser sessions use the `api/bbs` audience through `@herkules/oauth-client`. Agents use the `mcp/bbs` audience through `@herkules/auth-middleware`. Both produce the same `Principal`.
- Reads are anonymous. `/api/me` and future user-owned writes require membership. Per-user data keys only on `principal.subject`.

## Connecting an MCP client

`https://herkules.dev/mcp/bbs` is the read-only MCP endpoint. `web/src/account/McpGuide.tsx` renders the same instructions in Chinese on the account page.

- **Claude Code.** Run `claude mcp add --transport http rm-wenku https://herkules.dev/mcp/bbs`, then `/mcp` in a session. OAuth uses DCR; there is no token to paste.
- **Cursor.** Put `{ "mcpServers": { "rm-wenku": { "url": "https://herkules.dev/mcp/bbs" } } }` in `.cursor/mcp.json` for the project or `~/.cursor/mcp.json` globally. Save, open Customize → MCPs, and connect `rm-wenku`. Cursor's documented web and desktop callbacks are both allowed.
- **VS Code 1.106+.** Put `{ "servers": { "rm-wenku": { "type": "http", "url": "https://herkules.dev/mcp/bbs" } } }` in the workspace's `.vscode/mcp.json` or in the profile opened by the "MCP: Open User Configuration" command (or answer "MCP: Add Server" → HTTP), then sign in from the server's entry. OAuth uses CIMD or DCR at VS Code's choice.
- **Codex.** Run `codex mcp add rm-wenku --url https://herkules.dev/mcp/bbs` then `codex mcp login rm-wenku`. The `~/.codex/config.toml` equivalent is a `[mcp_servers.rm-wenku]` table with `url`. In the IDE extension, choose gear → MCP servers → Add server → Streamable HTTP → URL → Save, restart the extension, then authenticate. OAuth uses CIMD or DCR.
- **Zed.** Use Add Server → Add Remote Server in the Agent settings page, or put `{ "context_servers": { "rm-wenku": { "url": "https://herkules.dev/mcp/bbs" } } }` in Zed's `settings.json`. Leave out `Authorization`; Zed starts the MCP OAuth flow itself.
- **Gemini CLI.** Run `gemini mcp add --transport http --scope user rm-wenku https://herkules.dev/mcp/bbs`, then run `/mcp auth rm-wenku` inside Gemini CLI. Automatic OAuth discovery uses DCR and a loopback callback.
- **GitHub Copilot CLI.** Run `/mcp add` and enter the name, HTTP transport, URL, headers, and tools `*`. The equivalent `~/.copilot/mcp-config.json` entry is `{ "mcpServers": { "rm-wenku": { "type": "http", "url": "https://herkules.dev/mcp/bbs", "tools": ["*"] } } }`. There is no auth path.

Copilot CLI is not supported: it has no OAuth flow for remote servers and can only send static headers, while this platform issues no long-lived tokens. The only stopgap is a 15-minute JWT from [`/dev-token`](https://herkules.dev/dev-token) for the `mcp/bbs` audience, passed as `"headers": { "Authorization": "Bearer <token>" }`. It is enough for one test, not for daily use. The Copilot coding agent on github.com does not support remote OAuth MCP at all.

## Corpus and search

- `src/db/schema.ts` owns the Postgres schema. Timestamps use `timestamptz(3)`, structured payloads use `jsonb`, title labels use `text[]`, and `ai_usage.user_id` stores the issuer `sub`.
- `src/import/run.ts` is a destructive full-corpus replacement intended for cutover and development. It reads SQLite in foreign-key order, verifies order-independent SHA-256 digests after writing, records the run, and becomes a no-op only when source digests and derivation versions match.
- `src/db/search/` owns the search implementation selected by `SEARCH_INDEX`. `trgm` is the default on stock Postgres; `pgroonga` is the explicit fallback.
- Derived output versions live beside their algorithms. Current constants are `RENDER_VERSION` in `src/content/render.ts`, `NORMALIZE_VERSION` in `src/db/search/normalize.ts`, and `TITLE_VERSION` in `src/content/title.ts`. Bump the owning constant whenever existing rows must be rebuilt under changed logic.
- Public response shapes belong to `src/api/schemas.ts` and `src/api/dto.ts`; routes belong to `src/api/routes.ts`. The SPA consumes the Hono RPC contract rather than a parallel OpenAPI description.

## Crawler policy

- `src/guard/policy.ts` owns the fixed source-safety policy: at least 2 seconds plus up to 1 second jitter between requests, 20 requests per minute, 2,000 per UTC day, and 200 daily requests reserved from background work. Cooldowns step through 60 seconds, 5 minutes, 30 minutes, 2 hours, and 24 hours.
- Interactive work may use the reserve. Background work stops while degraded or while the reserve is held. A wait longer than 30 seconds surfaces as throttled work instead of sleeping in a request.
- `src/crawl/worker.ts` owns scheduling. Discovery runs at startup and every 10 minutes with up to 30 seconds jitter. Manual `work --once` allows one backfill page, ten fetches, and five refreshes.
- One worker process runs two supervised loops and holds a Postgres advisory lock. A second worker exits before issuing a source request.
- The crawler only reads the public RoboMaster forum. It does not log in, bypass access controls, crawl other hosts, generate AI content, or delete articles missing from listings.

## Operational stop condition

Do not work around source blocking. If the deployed Hong Kong host cannot fetch both required public forum endpoints with the configured user agent, or the fixed policy still causes sustained 403 or 429 responses, stop the worker and reassess the source and deployment location. The relevant boundaries are in `src/source/robomaster.ts`, `src/source/http.ts`, and `src/guard/policy.ts`.

## Page rendering

The SPA is static; the server injects `<title>`, description, canonical and `og:*` for `/articles/:id` and `/kb/:name` (`src/spa/head.ts`, `src/spa/static.ts`, the marker block in `web/index.html`). That is what Feishu and WeChat link cards need; Baidu indexing of article bodies is not a goal.

TanStack Start was evaluated on 2026-08-28 and not adopted. Measured on the repo's toolchain (vite-plus 0.3.0 = Vite 8.2.2/Rolldown, Node 24, TypeScript 7): `@tanstack/react-start@1.168.49` builds and serves without Nitro, with Hono as the outer server, at about 90 MB RSS and 7 ms per server-rendered request; `vp dev` works; none of the open Vite 8 issues reproduced. It is still a release candidate patched every few days and its document handler cannot run under Vitest. Nothing the product lacks justifies that dependency.

Revisit when an app needs a server-rendered document with per-user data (the member onboarding app is the candidate) or when Start ships 1.0. If adopted, the shape is fixed: Hono outer; the built `dist/server/server.js` imported by `main.ts` and mounted as the last route; loaders keep the Hono RPC client with an in-process `fetch`; no server functions, no Start server routes, no Nitro; exact version pins; `ssr: false` on `/account`.

## Code map

- `src/app.ts`, `src/main.ts`: composition, commands, routes, static serving
- `src/library/`: query layer and search results
- `src/mcp/`: MCP presentation and tools
- `src/import/`: SQLite conversion and verification
- `src/crawl/`, `src/guard/`, `src/source/`: worker, request policy, forum adapter
- `tests/import.test.ts`, `tests/search.test.ts`, `tests/crawl.test.ts`, `tests/e2e.test.ts`: binding behavior
