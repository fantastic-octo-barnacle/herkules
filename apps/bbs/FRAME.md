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

- _Superseded 2026-08-28 by Frame 2 below._ The crawler (discovery, fetch,
  guard, backfill, refresh queue, poll runs, status SSE). The old box keeps
  crawling; `sources`, `poll_runs`, `source_guard_state` are imported read-only.
- AI inference: generation pass, chat, `ask_article`, provider config,
  budgets, cost accounting, usage ledger UI. `article_ai`, `kb_entities`,
  `article_entities`, `ai_usage` are imported and read. _(Still out after
  Frame 2: articles crawled after cutover have no overview until an AI
  phase exists.)_
- Anonymous rate limiting (decided out of v1 by the user). When it comes: a
  Hono middleware keyed on principal `sub` else client IP behind
  `TRUSTED_PROXIES`, in-process token bucket (one replica), tighter on search.
- Embeddings, pgvector, semantic search.
- Admin page; any write to imported tables from the app. _(Writes: superseded
  by Frame 2. Admin page: still out.)_
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

---

# Frame 2: bbs crawler — 2026-08-28

Supersedes Frame 1's "Out of scope: the crawler" and its write model ("v1
never writes to imported tables"). AI inference stays out. Everything else
in Frame 1 stands.

## Problem

The port reads a corpus it cannot produce. New forum posts reach
`bbs.herkules.dev` only when someone copies a `wenku backup` off the old
Singapore box and runs `bbs import`. That box is a second machine, schema,
language and deploy pipeline for one product, and nobody else can host RM
文库 without it. We want herkules to discover, fetch, render and index the
forum itself — in TypeScript, against the `bbs` Postgres database, with
policy identical to the crawler that has run without incident — so the
Singapore box can be switched off and a stranger with an empty database can
build the same corpus.

## Prior art

- **`../rm-wenku`** — the crawler being ported. Facts that shape this frame:
  - **The queue is SQL, not a data structure.** Fetch work is a projection
    (`next_refresh` → `next_pending` → backfill cursor on `sources`) over
    `articles.status` / `refresh_requested_at` / `updated_at`. Only the wake
    signal (`tokio::Notify`) and the event bus (in-process ring of 400, 30
    message variants, SSE) are process-local — which makes a separate
    worker process nearly free and the event bus droppable.
  - **Guard policy**: 2 s spacing + 0–1 s jitter, 20/min, 2 000/day anchored
    at UTC midnight, background reserve 200 (`max(day/10, 50)`), cooldown
    ladder 60 s → 5 m → 30 m → 2 h → 24 h on 429/403/5xx/network/WAF
    (`max(Retry-After, step)`, capped 24 h), any success resets, `max_wait`
    30 s else `Throttled`; `Refresh` work bypasses the reserve, `Fetch` and
    `Backfill` are background. State is one JSON blob per source in
    `source_guard_state`, upserted on every request — the table and columns
    bbs already has.
  - **Forum API**: two POST endpoints on `https://bbs.robomaster.com`
    (`/developers-server/rest/posts/list` with
    `{pageSize, pageNo, filter:{category:"ARTICLE", sortByCreateAt:true, tagIds:[]}}`;
    `/developers-server/rest/posts/info/{id}` with `{}`), 5 MiB body cap, no
    redirects, one allowed origin, UA `rm-wenku/0.2 (+public article
monitoring; rate limited; …)`, 15 s / 10 s timeouts, no retry (the guard
    is the retry). Articles match on `(source_id, source_article_id)`; ids
    are locally minted ULIDs; the URL is minted
    (`{origin}/article/{id}?source=1`). Discovery every 600 s (+0–30 s
    jitter), page 1 of 20, startup poll on; fetch spacing 10 s; backfill one
    page of 20 per run from `sources.backfill_next_page` (starts at 2);
    lazy refresh when a reader opens an article with `fetched_at` older than
    24 h (`refresh_requested_at`, idempotent); failed rows retry after
    3 600 s; `content_changed_at` set only when the SHA-256 of `body_text`
    changes; `article_images` upserted on `(article_id, url)` so caption
    columns survive, `article_links` replaced, tags written for new rows only.
  - **Not yet in TS** (the handoff over-counted): `extract/` (raw HTML /
    markdown → `body_text`, links, images; 648 lines), `title.rs` (season /
    team / topic / labels; 889 lines, with `fixtures/title-parser/`),
    `text/links/url/hash` (~280). `render.ts` and link-target resolution
    are. Recorded API fixtures exist: `fixtures/robomaster/{list_page,
post_html, post_markdown, post_missing}.json`.
  - **Sizes**: source 600, guard 1 000, workers 941, ingest 1 186, poll
    runs / sources / guard store 450, write side of `articles.rs`, core
    1 800 — ≈ 8k Rust lines, ~4–5k TS expected.
- **Production state** (user, 2026-08-28): the live rm-wenku box is in
  Singapore and has all 908 fetched articles generated; the local
  `data/app.db` (105 ready) is a stale copy. The cutover import comes from a
  fresh Singapore backup; development uses the stale copy.
- **Ecosystem**: pg-boss / graphile-worker not needed (the queue is SQL);
  `ulid` for ids. No RM-forum crawler exists on npm or GitHub.

## Decision

**A second compose service `bbs-worker` from the same image
(`node dist/main.mjs work`) owns every corpus write — discovery, fetch,
backfill, refresh — as a line-for-line port of rm-wenku's policy into
`apps/bbs/src/{source,guard,crawl}` and `src/content/{extract,title}`.
The API container keeps serving reads. `bbs import` is deprecated in place.
No AI code is written.**

Write model (replaces Frame 1's "v1 never writes"):

- The worker writes one transaction per article: the row plus every derived
  column — `content_html` (`renderArticleHtml`), title parts (ported
  `title.ts`), `article_search.document` (`buildDocument`),
  `article_links.target_article_id` (`resolveLinkTarget` against the DB:
  `canonical_url` equality and `/article/{n}` against `source_article_id`),
  and the back-fill of `target_article_id` on existing links that point at
  the new article. The alignment CHECKs already hold per row, so incremental
  writes keep them. `kb_search` is never written (AI).
- `bbs import` stays exactly as it is, header marked deprecated: still the
  dev loader (`vp run import`) and the cutover tool. Two callers of the same
  derive functions, no shared `writeArticle`, no refactor. It does not carry
  `context_text`; the AI phase will re-import from a backup kept on R2.
- Versions: `RENDER_VERSION` / `NORMALIZE_VERSION` / new `TITLE_VERSION`
  live in a `corpus_versions` single row. The API rederives at boot when
  they differ from the code's (batches, ~3 s for 1 000 rows, inside the
  migration phase); `bbs rederive` is the same pass as a CLI.
- On worker start: `poll_runs` rows left `running` become
  `failed (interrupted…)`; the `sources` row `robomaster` is ensured from
  constants — a fresh database needs nothing else.

Process shape:

- One image, three commands: `migrate` (one-shot compose service; `bbs` and
  `bbs-worker` `depends_on: service_completed_successfully`; neither
  long-running process migrates), `serve` (API; its one write is
  `refresh_requested_at` on a stale GET, as rm-wenku), `work` (three
  supervised loops — discovery, fetch ladder, wake signals in-process,
  restart-on-crash with 30 s → 600 s backoff; `--once` runs a single
  discovery + fetch cycle for tests and the manual check).
- Policy numbers are constants in code, the forum URL included. No env
  knobs (the archived project has them if ever needed). Tests inject a
  permissive guard and a fake `fetch` through constructors.
- No status table, no events table, no SSE, no admin surface, stdout logs
  only. `/api/status` and MCP `library_status` already report
  `max(poll_runs.started_at)`, so they go live by themselves; the Status
  page is untouched until its redesign.
- `bbs-worker`: same env as `bbs`, `mem_limit` 256m, `restart:
unless-stopped`, scaled to 0 until cutover step 4.

Cutover (Singapore box → herkules):

1. From the herkules box, POST both forum endpoints with the old UA — the
   one manual live check (kill criterion 1).
2. `compose up -d` with `migrate`, `bbs`, and `bbs-worker` at scale 0.
3. Stop the old crawler; `wenku backup`; copy; `bbs import /import/app.db`
   (ULIDs, `backfill_completed_at` and the guard state come with it, so
   nothing is re-crawled).
4. `up -d --scale bbs-worker=1`. First discovery closes any gap of fewer
   than 20 new posts.
5. Old box off after one week of clean `poll_runs`. From then on articles
   have no overview until an AI phase exists — accepted.

Alternatives considered:

- **Incremental writes** (chosen) over the **bridge** (Rust crawler stays,
  scheduled import; zero code, two schemas forever) and over **staging
  tables + swap**.
- **Two callers of shared derive functions** (chosen) over **refactoring
  `import` onto one `writeArticle`** — import is deprecated; work on it is
  waste.
- **Separate worker container** (chosen) over **in-process workers** (old
  shape; crawl I/O on the API's event loop) and over a **`crawl --once`
  compose loop** (loses wake-on-ingest and the interruptible throttle
  sleeps that make the guard correct).
- **Rows as API→worker signal** (chosen; fetch idle recheck 600 s → 60 s so
  a refresh request is honoured within a minute) over **`LISTEN/NOTIFY`**.
- **Constants** (chosen) over **porting the 25-knob config** — tuned once,
  archived.
- **Port backfill** (chosen) over **skipping it** because production has
  completed it — it is what lets anyone else host this from an empty
  database.
- **Crawler now, AI never in this phase** (chosen) over **crawler + AI in
  one phase** — AI is ~8k more lines and its own provider / budget / prompt
  decisions; the user deferred it entirely.
- **Rederive at boot** (chosen) over **refuse to boot on version mismatch**
  — a code change must not become an outage step.

## In scope

- `apps/bbs/src/source/` (forum adapter, DTOs, mapping, HTTP client with
  origin policy, `ulid` ids), `src/guard/` (policy, clock, Postgres store),
  `src/crawl/` (discovery, fetch ladder, backfill, refresh, poll runs,
  supervision, `work` / `work --once`), `src/content/extract.ts` and
  `src/content/title.ts` (+ `text/links/url/hash` helpers), the article
  write transaction, `corpus_versions` + rederive at boot + `bbs rederive`,
  the `migrate` command, `refresh_requested_at` on stale GET.
- `tools/deploy`: `bbs-migrate` one-shot, `bbs-worker` service, README
  cutover + self-host sections.
- Fixtures copied from rm-wenku: `fixtures/robomaster/*.json`,
  `fixtures/title-parser/*`.
- Tests: guard policy against rm-wenku's numbers; adapter mapping on the
  fixtures; title parser on the fixture corpus; `work --once` end to end on
  PGlite with a fake `fetch`; write invariants (CHECKs, link back-fill,
  image upsert survivals, refresh idempotence); rederive no-op.
- `apps/bbs/DESIGN.md` round 3 (crawler).

## Out of scope

- AI in every form: generation, chat, `ask_article`, provider, budgets,
  ledger, `context_text`, `kb_search` writes, `kb_entities` growth.
- Status page redesign, worker status table, event bus, SSE, live console.
- Admin surface of any kind (routes, page, MCP tools, `poll now` /
  `refetch` / `backfill reset`). Only `bbs rederive` exists as a CLI besides
  `migrate` / `serve` / `work` / `import`.
- Any change to `bbs import` beyond a deprecation note.
- Env-configurable crawl policy; a second source kind; more than one replica
  of either container; `LISTEN/NOTIFY`.
- Rate limiting, embeddings, PGroonga (unchanged from Frame 1).
- Any change to the API read contract, the MCP read tools, or the SPA.

## Kill criterion

If `bbs.robomaster.com`'s list/info endpoints refuse the herkules box (WAF,
geo, or a sustained 403 the cooldown ladder cannot clear within a day), the
box cannot be the crawler: stop and re-frame between the bridge (rm-wenku's
crawler kept headless, scheduled `bbs import`) and crawling from another
vantage point. Do not tunnel around it silently.

If the crawler needs a derived value that `renderArticleHtml` /
`buildDocument` / `resolveLinkTarget` / `title.ts` cannot produce, the two
write paths have diverged: stop and re-frame the write model before adding a
crawler-only derivation.

## Done predicate

1. On PGlite with a fake `fetch` serving the fixtures, `bbs work --once`
   discovers the fixture's new post, fetches it, and the article appears in
   `/api/articles`, `/api/search` (with snippet) and `/api/articles/:id`
   with `contentHtml` and title parts; a second `--once` changes no row;
   `poll_runs` records both runs.
2. Guard tests reproduce rm-wenku's numbers: spacing, 20/min, 2 000/day
   reset at UTC midnight, reserve 200 held for background work and not for
   refresh, the cooldown ladder, `Throttled` past 30 s; state round-trips
   through `source_guard_state`.
3. Title parser output equals `fixtures/title-parser/corpus.expected.jsonl`.
4. `bbs rederive` on the imported corpus is a no-op (every derived column
   recomputed equals the imported value).
5. Reproducibility: on an **empty** database, `work` (real network, from a
   permitted vantage point) creates the `sources` row, discovers page 1 and
   backfills page by page; the run is stopped after ≥ 3 pages and every
   stored article is readable in the SPA.
6. On the box: a post published on the forum after cutover is in Browse and
   Search within 15 minutes with the Singapore box stopped; `poll_runs`
   shows a clean week; the old box is decommissioned.

## Verification to do before build

- From the herkules box, with rm-wenku's UA:
  `curl -X POST https://bbs.robomaster.com/developers-server/rest/posts/list -H 'Content-Type: application/json' -d '{"pageSize":1,"pageNo":1,"filter":{"category":"ARTICLE","sortByCreateAt":true,"tagIds":[]}}'`
  returns JSON; then `/posts/info/{id}` for the returned id. This is the
  only live check; everything else runs on fixtures.
- `fixtures/robomaster/*.json` still match today's API shape (compare the
  live response above against `list_page.json` field by field).
- Drizzle `migrate()` as a one-shot command exits 0 on an already-migrated
  database (compose reruns it on every `up`).
