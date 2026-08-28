# Frame: bbs (RM WenKu port) — 2026-08-28

## Problem

RM WenKu (RM 文库) is the team's archive, search engine and AI reading
companion for the RoboMaster developer forum: ~1,000 crawled articles with
tags, links and images, 105 model-generated overviews / knowledge-base entries,
788 cross-article entities, and an MCP server so coding agents can read it. It
runs today as one Rust binary on SQLite on its own 1 GB box, with its own
GitHub login. We want it to be the first product inside the herkules monorepo:
identity from the herkules issuer, data in Postgres, the API / MCP / frontend
in TypeScript next to the auth layer, deployed by the same pipeline. The
crawler and the AI inference stay on the old box for now; the port must read
everything they have produced and keep reading it as they produce more.

## Prior art

- **`../rm-wenku`** (the thing being ported; 47 commits, 2026-08-26 → 27).
  16 tables + 2 FTS5 virtual tables, 49 MB SQLite (969 articles, 3.6k images,
  3k links, 105 `article_ai`, 788 entities, 1 user, 0 PATs). Unix-ms
  timestamps, ULID ids, JSON in TEXT. **No vectors, no blobs, no files on disk**
  — images are hot-linked to the forum CDN. The SQLite-specific surface is the
  real port work: FTS5 `trigram` + `bm25` + `snippet()`, and
  `json_extract`/`json_each` over `overview_json`/`kb_json` driving `/kb`
  browse, facets and genre filters. Search does not depend on inference.
  Frontend is React 19 + react-router 8 + TanStack Query 5 (10k lines, Chinese
  UI) typed from `openapi-typescript`; server-side `<title>`/`og:*` injection
  for `/articles/:id` and `/kb/:name`. REST API ~35 routes, MCP 11 tools (10
  anonymous reads + `ask_article`). Auth: `github_id` key, `rm_session` cookie,
  `rmk_` PATs. **Ported**: schema semantics, the SPA's page modules and styles,
  the MCP tool surface, the head injection. **Left behind**: Rust, SQLite,
  its auth, its OpenAPI contract, the crawler, inference.
- **`../herkules-old/apps/wenku`** (abandoned port, uncommitted). Two pieces
  were measured to work and are **copied in, then edited**: the Drizzle
  Postgres schema (`src/db/schema.ts` + `drizzle/0000_init.sql`: ms →
  `timestamptz(3)`, 0/1 → `boolean`, JSON → `jsonb`, `title_labels` →
  `text[]`, `article_tags.position` from rowid) and the SQLite→Postgres
  migrator (`src/db/migrate-sqlite.ts`: `node:sqlite`, `TableSpec[]` in FK
  order, truncate-and-reload in one transaction, order-independent SHA-256
  read-back per table; whole corpus in 2.3 s). Its PGroonga indexes, custom
  Postgres image and speculative `article_chunks vector(1024)` table are
  **dropped**. Its TanStack Start + Nitro-beta shape and the plan to
  reproduce `/api/v1/*` byte-for-byte are **not followed**. It also recorded
  the decision not to port `wenku-store` to sqlx-postgres; this frame agrees.
- **This repo.** `apps/*` is globbed in `pnpm-workspace.yaml` and empty.
  `packages/auth-middleware` has `apiResource()` + `honoAuth()`;
  `services/mcp-directory` is the MCP template (SDK 2.0 `createMcpHandler`,
  fresh server per request); `services/auth/src/clients.ts` already seeds a
  first-party `skipConsent` client at boot (`herkules-web`); the registry is a
  checked-in list. Postgres is stock `postgres:17-alpine`; tests run on
  PGlite 0.5.8, which ships `pg_trgm`.
- **Ecosystem.** Nothing off-the-shelf is this product. Library choices are
  all in the Decision section.

## Decision

**`apps/bbs`: one Hono service (API + MCP + static TanStack SPA + head
injection) on its own database, served at `bbs.herkules.dev`, authenticating
browsers as a confidential OAuth client of the herkules issuer and agents as a
JWT resource server; the corpus arrives by a repeatable checksum-verified
import from the old box's SQLite.**

Topology (one container `bbs`, port 3003):

| URL                                              | Served by                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `bbs.herkules.dev/*`                             | `apps/bbs`: static SPA (`<title>`/`og:*` injected for article and entity pages) |
| `bbs.herkules.dev/api/*`                         | `apps/bbs` Hono API                                                             |
| `bbs.herkules.dev/login`, `/callback`, `/logout` | `packages/oauth-client` routes mounted in `apps/bbs`                            |
| `herkules.dev/mcp/bbs`                           | `apps/bbs` MCP handler (Caddy routes the platform path to the same container)   |

Registry gains `{ name: "bbs", kind: "api" }` and `{ name: "bbs", kind: "mcp" }`
→ audiences `https://herkules.dev/api/bbs` and `https://herkules.dev/mcp/bbs`;
the auth service serves both PRM documents as it does today.

Data:

- Database `bbs` in the existing Postgres container, `DATABASE_URL` of its
  own, Drizzle migrations applied at boot (same pattern as `services/auth`),
  its own `pg_dump` line in the backup cron.
- Schema: herkules-old's, minus `users`/`sessions`/`api_tokens`/`article_chunks`,
  minus PGroonga. `ai_usage.user_id` becomes `text` holding the issuer `sub`.
  FTS5 tables become real tables `article_search` / `kb_search` with
  `pg_trgm` GIN indexes on stock Postgres. `overview_json`/`kb_json` are
  `jsonb`; the JSON1 queries are rewritten with `->>` / `jsonb_array_elements`.
- Search: substring conjunction (`document LIKE '%term%'` per term) over one
  normalised `document` column per search table, accelerated by a
  `gin_trgm_ops` index; a bm25-shaped ranking expression in SQL (term
  frequency per field, idf from one stats query); snippets computed in
  TypeScript. Guarded by done-predicate check 5; the planned fallback is
  PGroonga on the two search tables (a migration and an image change, not a
  rewrite). _Amended 2026-08-28: the original sentence said
  `similarity()`/`word_similarity()` ranking; measured on pg_trgm 1.6, a
  two-character CJK term inside a sentence scores exactly 0 and `%` returns
  no rows where `LIKE` returns thousands, because pg_trgm pads words and a CJK
  run is one word. Both design candidates refused it independently. Unlike
  FTS5, no term is dropped for being shorter than three characters — check 5
  is compared with that caveat._
- Import: `bbs import <app.db> [--user-map <old_id>=<sub>]` — the old
  migrator, edited. Reads SQLite via `node:sqlite` (so rm-wenku's stale
  `_sqlx_migrations` checksum is irrelevant), truncates and reloads every
  table in one transaction, verifies read-back checksums, exits non-zero on
  mismatch. Run on the box as `docker compose run --rm bbs import
/import/app.db` from a `wenku backup` file copied off the old server; it is
  the sync mechanism until the crawler is ported. v1 never writes to imported
  tables, so reload-and-replace stays correct.

Auth:

- `packages/oauth-client` (`@herkules/oauth-client`): Hono routes
  `login` / `callback` / `logout`; authorization-code + PKCE + `state`
  against `{issuer}/.well-known/openid-configuration`; confidential client
  (`client_secret_basic`); requests `resource=<api audience>` and
  `offline_access`; stores access + refresh token in a **sealed cookie**
  (encrypted with an app key, rotated on refresh) — no table, no schema, so
  app #2 adopts it with three lines. Yields the same `Principal` type
  `auth-middleware` yields for bearer callers by verifying the access token
  with `apiResource()`, so handlers never know whether a browser or Claude
  Code is calling. Revocation is the issuer's (revoke client/session →
  refresh fails → signed out within 15 min). Identity is the access token's
  `sub` + role; display name/avatar via the user-info API. The `openid`
  scope is filtered away per resource today, so this is an OAuth 2.1 client
  that happens to talk to an OIDC issuer; no id_token is used. The name is
  honest about that.
- `services/auth`: second entry in `FIRST_PARTY_CLIENTS` — `bbs`,
  confidential, `skipConsent: true`, redirect `https://bbs.herkules.dev/callback`
  (+ the dev origin), secret from `BBS_CLIENT_SECRET`. Consent is not shown to
  first-party apps; this is the "first-party token exchange, not consent" the
  root frame reserved.
- Access policy: web reads anonymous; every API route that is not a read, and
  every MCP call, requires a member principal. Admin role from the JWT.

API / MCP / frontend:

- Hono routes with zod schemas; types reach the SPA through Hono RPC
  (`hc<AppType>`) — a fresh contract, no `/api/v1` compatibility, no OpenAPI.
- MCP: SDK 2.0 `createMcpHandler` per the `mcp-directory` template; the 10
  read tools of rm-wenku (`search_articles`, `list_articles`, `get_article`,
  `get_overview`, `get_kb`, `search_kb`, `list_entities`, `get_entity`,
  `list_tags`, `library_status`) and the `rm://articles/{id}[/overview|/kb]`
  resources; `ask_article` omitted with inference.
- Frontend: TanStack Router (file routes, loaders) + TanStack Query, Vite
  static build served by the Hono container. rm-wenku's `browse/`, `reader/`,
  `kb/`, `components/`, `styles/` and Chinese message catalogue ported mostly
  verbatim; router and API client replaced. Pages: Browse, Article, Kb,
  KbEntity, Status (library counts + last import time; no SSE), About,
  Account. No Admin page: every admin action was a crawl or AI operation.

Alternatives considered:

- **Own subdomain as a standard OIDC client** (chosen) over **path-mounted on
  `herkules.dev` sharing the session cookie** — a product wants its own
  origin, and the client package is needed for every future app anyway.
- **TanStack Router SPA + Hono BFF** (chosen) over **TanStack Start** (SSR,
  server functions; the Nitro-beta pinning of herkules-old) and over a
  **browser PKCE public client** (refresh tokens in browser storage for no
  gain).
- **Sealed cookie** over a **session table** — zero schema per adopter; the
  15-minute access token already bounds revocation lag.
- **`pg_trgm` on stock Postgres** over **PGroonga** (custom image, Docker
  Postgres in the test path, better CJK ranking — kept as the fallback) and
  over **`tsvector`+zhparser** (custom image, worse fit).
- **Own database** over a **schema in `herkules`** (different backup/restore
  lifecycle: the corpus is re-imported, auth never is) and over a **second
  Postgres container** (512 MB for nothing).
- **Copy herkules-old's schema + migrator and edit** over **rewrite from
  rm-wenku's migrations** — the one measured artefact of that attempt.
- **Fresh API contract** over **reproducing `/api/v1/*`** — no consumer
  exists besides the SPA and MCP.
- **Repeatable import with the old box crawling** over **freeze at cutover**
  — the deferral must not silently freeze the product.

## In scope

- `apps/bbs`: Drizzle schema + migrations, `import` CLI, Hono API, MCP
  handler, head injection, static SPA serving, Dockerfile target, compose
  service, Caddy snippets (`bbs.herkules.dev` site + `/mcp/bbs` route),
  backup line, GHCR image in `images.yml`.
- `packages/oauth-client`: routes, sealed-cookie session, refresh, principal.
- `services/auth`: `bbs` first-party confidential client; two registry lines.
- Relevance golden set: 20 real queries with FTS5 top-5 captured from the old
  box, checked in as a fixture.
- `apps/bbs/DESIGN.md` and `packages/oauth-client/DESIGN.md`.

## Out of scope

- The crawler (discovery, fetch, guard, backfill, refresh queue, poll runs,
  status SSE). The old box keeps crawling; `sources`, `poll_runs`,
  `source_guard_state` are imported read-only.
- AI inference: generation pass, chat, `ask_article`, provider config,
  budgets, cost accounting, usage ledger UI. `article_ai`, `kb_entities`,
  `article_entities`, `ai_usage` are imported and read.
- Anonymous rate limiting (decided out of v1 by the user). When it comes: a
  Hono middleware keyed on principal `sub` else client IP behind
  `TRUSTED_PROXIES`, in-process token bucket (one replica), tighter on search.
- Embeddings, pgvector, semantic search.
- Admin page; any write to imported tables from the app.
- PAT / `rmk_` tokens, stdio MCP transport.
- OpenAPI document; `/api/v1` path compatibility.
- Any write-back or two-way sync to the old box.
- Rate limiting, Gatus/Beszel, analytics, Sentry (as in the root frame).

## Kill criterion

If the herkules issuer cannot serve a first-party confidential client that
skips consent and mints a resource-bound access token for `api/bbs` through
configuration alone (no library patch), the OAuth-client design is wrong: stop
and re-frame between a path-mounted app sharing the session cookie and a
first-party token endpoint in `services/auth`. Do not quietly bolt the BBS
onto the `herkules-web` dev-token flow.

Not a kill: pg_trgm failing check 5 — that triggers the planned PGroonga
switch on the two search tables.

## Done predicate

1. `bbs import` on the box loads the prod dump; every table's read-back
   checksum matches; running it again on the same dump is a no-op; a fresh
   dump from the old box a week later imports the delta the same way.
2. `bbs.herkules.dev` anonymous: Browse, Article, Kb, KbEntity, Search, Tags,
   Status render the imported data; `curl /articles/<id>` returns the injected
   `<title>` and `og:*`.
3. Login via the issuer shows no consent screen; `/account` shows the
   caller's display name from the user-info API; logout works; a member-only
   API route returns 401 anonymously and 200 signed in.
4. `claude mcp add --transport http bbs https://herkules.dev/mcp/bbs` → login
   → `search_articles` and `get_article` return real rows; a token for
   `mcp/directory` is rejected by `mcp/bbs` with the contract's 401.
5. Relevance: on the 20-query golden set, pg_trgm top-5 overlaps FTS5 top-5
   on ≥ 15 queries.
6. GHCR image → `compose pull && up -d` brings `bbs` up next to `auth`; a
   nightly dump of the `bbs` database lands in R2.

## Verification to do before build

- _Verified 2026-08-28 (`services/auth/tests/first-party.test.ts`)._ `FIRST_PARTY_CLIENTS` entry with a client secret and
  `tokenEndpointAuthMethod: "client_secret_basic"` is accepted by
  `adminCreateOAuthClient` and the token endpoint (the existing entry is a
  public client).
- _Verified 2026-08-28 (same file)._ `allowedScopes` for `kind: "api"` resources (`registry.ts` pins
  `["offline_access"]`) lets a confidential client obtain a refresh token.
- PGlite `pg_trgm` GIN index creation from the Drizzle migration file.
- On the box: `SELECT datctype FROM pg_database WHERE datname = 'bbs'` and
  `SELECT show_trgm('步兵')` — pg_trgm's word-character test runs through
  `iswalpha` under the database `LC_CTYPE`, so the trigrams the index stores
  for CJK depend on it. Recall does not (it is `LIKE`), index effectiveness does.
