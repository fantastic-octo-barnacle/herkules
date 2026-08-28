# `apps/bbs` — design, round 1: data, import, query layer, API + MCP surface, server shell

Round 2 (the SPA: screens, routes, data loading) is designed separately against the `AppType`
this round fixes. Bodies here are `not implemented`; the types and signatures are the contract.

## Problem

Port RM WenKu's read side onto Postgres inside herkules: ~1 000 crawled Chinese forum articles,
105 model-written overviews and knowledge-base entries, 788 entities, reached by a Hono API, an
MCP server and (round 2) a TanStack SPA, with the corpus arriving by a repeatable import from the
old box's SQLite. `FRAME.md` fixes the topology (one container, database `bbs`, `bbs.herkules.dev`,
`herkules.dev/mcp/bbs`), the auth (`@herkules/oauth-client` for browsers, `honoAuth` for agents,
the same `Principal`) and the search strategy (`pg_trgm` on stock Postgres, PGroonga as the
guarded fallback). What makes the shape non-obvious:

- **FTS5's `tokenize='trigram'` gave substring matching, `bm25()` and `snippet()` for free; stock
  Postgres gives none of the last two, and `pg_trgm`'s similarity functions are unusable for
  Chinese** — measured on pg_trgm 1.6: a two-character term mid-sentence scores exactly 0.0, and
  `t % '电机'` returns 0 rows where `LIKE` returns thousands, because pg_trgm pads each "word" with
  blanks and an unbroken CJK run is one word. FRAME's sentence "`similarity()`/`word_similarity()`
  ranking" is factually wrong for this corpus; both arena candidates refused it independently.
- **The corpus is immutable between imports.** The import is the only writer, so everything
  rm-wenku computed per request (HTML rendering, link resolution, search documents) can be derived
  once at import and never synchronised.
- **`contentHtml` was rendered per request** by 800 lines of Rust (pulldown-cmark + ammonia) and
  never stored; the port either puts a sanitiser in the request path or renders once.
- **Two N+1s and a 5-query `get`** in the source; the port must collapse them without a cache.
- **Full-width punctuation and 【】 are everywhere** in this corpus; PGroonga's normaliser folded them
  for free in herkules-old, `pg_trgm` does not, and `lower()` in SQL is not length-preserving.
- **The repo's conventions are strict**: `config.ts` is the only env reader; `createDb` speaks
  `postgres://` and `pglite://` (no `pg.Pool`); tests run in-process through the `fetch` seam;
  migrations apply at boot; `vp pack` emits `dist/main.mjs`; `services/web` is served by Caddy, so a
  Hono-served SPA with head injection has no precedent here.

## Usage (caller's view)

### The SPA (round 2), through Hono RPC

```ts
import { hc } from "hono/client";
import type { AppType } from "../../src/api/routes.ts"; // type-only; no codegen, no OpenAPI

const api = hc<AppType>(location.origin, { init: { credentials: "same-origin" } });

// Browse: the date-ordered feed, filtered; `q` narrows, never reorders. Cursor is opaque, keyset-based.
const page = await (
  await api.api.articles.$get({ query: { q: "步兵 底盘", scope: "all", group: "机械" } })
).json();
page.items[0].tldr; // present without a second request — one LEFT JOIN
const more = await api.api.articles.$get({ query: { cursor: page.nextCursor! } });

// Reader: one request, one query behind it. contentHtml was sanitised at import.
const article = await (await api.api.articles[":id"].$get({ param: { id } })).json();
article.contentHtml; // safe to inject
article.links[0].articleId; // set when the link points into the library
const ai = await (await api.api.articles[":id"].ai.$get({ param: { id } })).json(); // overview + kb + captions; status pending|ready|failed

// Ranked search with snippets. No `mode`: every term counts, however short.
const hits = await (await api.api.search.$get({ query: { q: "PID 整定" } })).json();
hits.items[0].snippet; // "…经验上 [PID] [整定] 先调 P…"

// Knowledge base: cards plus three cross-filtered facet axes, two queries.
const kb = await (await api.api.kb.browse.$get({ query: { domain: "算法" } })).json();

// Identity. `viewer` may be nobody (200 + null); `me` may not (401 anonymous).
const { viewer } = await (await api.api.viewer.$get()).json();
const me = await api.api.me.$get();
```

Dates cross the wire as ISO 8601 (`Wire<T>` in `api/dto.ts`); ids are the crawler's ULIDs. Errors are
`{ error, error_description }`: 400 (zod, bad cursor, blank search), 404 `not_found`, 401/403/503 from
auth-middleware's renderer. Login is `<a href="/login?next=…">`; logout is a POST form to `/logout`.

### An MCP tool body

```ts
// src/mcp/server.ts — the same Library the API uses; no SQL, no HTTP shape.
server.registerTool(
  "search_articles",
  { inputSchema, outputSchema, annotations: { readOnlyHint: true } },
  async ({ query, scope, tag, group, limit, cursor }) => {
    const page = await deps.library.search({ q: query, scope, tag, group, limit, cursor });
    return structured(
      { hits: page.items.map(articleHit), nextCursor: page.nextCursor ?? undefined },
      `${page.items.length} 篇`,
    );
  },
);
```

`articleHit` (`mcp/present.ts`) renders dates as `YYYY-MM-DD` in Asia/Shanghai and flattens the
summary for token budget — deliberately not the HTTP shape.

### The import

```console
$ docker compose run --rm bbs import /import/app.db --user-map 01M10NTP…=usr_7c1f…
bbs import  source=/import/app.db (49.3 MB, sqlx 1..6)  target=…/bbs
  table                rows   checksum       status
  articles              969   a71e0c4d8b21   ok    (+905 content_html)
  article_links        3073   6b03d1f42a97   ok    (+1244 target_article_id)
  article_search        905   0b17f9e5c8d0   ok    (+905 document)
  …
  skipped: users(1) sessions(1) api_tokens(0)
  notes:   ai_usage: 1 row had an unmapped user_id (01TESTMEMBER…) -> NULL
ok  13 tables, 13 574 rows, 2.9 s  (verified before commit; run 01J…)
$ docker compose run --rm bbs import /import/app.db
no-op  digests and versions equal run 01J… (render 1, normalize 1)
```

Run it twice and the second run opens no transaction. Kill it halfway and nothing changes.
`--dry-run` hashes without touching Postgres.

### Composition root (`main.ts`)

```ts
if (config.createDatabase) await ensureDatabase(config.databaseUrl); // creates `bbs` if absent; no-op on pglite
const db = await createDb(config.databaseUrl);
await migrate(db); // pg_trgm loaded for PGlite
const search = selectSearchIndex(config.searchIndex, (q) => db.execute(q)); // SEARCH_INDEX=trgm | pgroonga
const library = createLibrary({ db, search });
const api = apiResource({ resource: config.apiResource, issuer, jwksUrl, fetch });
const mcp = mcpResource({ resource: config.mcpResource, issuer, jwksUrl, fetch });
const oauth = honoOAuth(
  createOAuthClient({
    auth: api,
    client: { id: "bbs", secret },
    origin: config.appOrigin,
    cookieSecret,
    issuerInternal,
    fetch,
  }),
);
const { app } = createApp({
  library,
  oauth,
  mcp,
  userInfo,
  spa: await createSpaHandler({ webDir, library, appOrigin }),
  appOrigin,
  ping,
});
```

## Shape

### Data structures first

Five decisions about data settle almost everything else (`src/db/schema.ts`):

1. **The corpus is immutable between imports, so four things move to import time.**
   `articles.content_html` (rendered + sanitised, `content/render.ts`), `article_links.target_article_id`
   (in-library link resolution), and the two `document` columns. Each is _derived_, never synced; a
   re-import recomputes from scratch and `import_runs.render_version` / `normalize_version` record which
   code produced what is on disk. The article read is one query where rm-wenku needed six plus a render.
2. **`document` is a normalised, length-preserving fold of the row's text, and the database checks that.**
   `db/search/normalize.ts` maps code unit to code unit (full-width ASCII → ASCII, U+3000 → space,
   per-unit lower-case only when it stays one unit). Consequence: _an offset in the folded document is the
   same offset in the raw text_, so `substr(document, 1 + Σ(len + 1), len(field))` **is** the folded field
   (ranking, `scope=title`), and snippets are cut from the **original** text — original case, original
   【】 — around a match found in the fold, in TypeScript. `article_search_document_aligned` is a `CHECK`
   comparing `length(document)` to the sum of the field lengths plus separators, on every imported row.
   There is exactly one fold definition in the system and it is TypeScript; SQL never re-folds.
3. **Search recall is substring conjunction, not similarity.** FTS5's quoted-term `MATCH` is exactly
   `document LIKE '%t1%' AND document LIKE '%t2%'`, and `gin_trgm_ops` accelerates precisely that (≥ 3
   characters; below, a 905-row seq scan in milliseconds). Ranking is bm25's _shape_ without bm25: tf via
   `(length(F) - length(replace(F, t, ''))) / length(t)` on the document slices, idf from one aggregate
   query, per-field length normalisation with k₁ = 1.2 / b = 0.75 — evaluated only on rows the index
   admitted. **No term floor and no `fts`/`fuzzy` mode** (see Tradeoffs).
4. **Cursors are keyset.** The sort key `(COALESCE(published_at, discovered_at) DESC, listing_position ASC,
id DESC)` is total (ULIDs); `articles_feed_idx` is the expression index over exactly that triple, partial
   on `status='fetched'`. Offsets are wrong here because `bbs import` rewrites every row weekly while people read.
5. **Domain types carry `Date`; each transport presents them.** HTTP renders ISO 8601; MCP renders
   `YYYY-MM-DD` in Asia/Shanghai and pages content by characters. Two presenters, one domain.

Plus: `article_tags.group_name` is a **generated column** (`split_part(tag,'/',1)`) — the `group/name`
string convention gets one home; `article_ai.context_text` is **not ported** (chat-only, never in a
response, 2.1 MB); `content_raw` is kept (`format=markdown`, re-render). Thirteen imported tables plus
the app-owned `import_runs`.

### Module map

```
config.ts          env -> Config. Two origins, both required, both named. SEARCH_INDEX, BBS_CREATE_DATABASE.
app.ts             every route, in order: /healthz, /mcp/bbs, oauth routes, /api/*, SPA last.
main.ts            composition root, the `fetch` seam, `bbs import` dispatch.
db/schema.ts       13 imported tables + import_runs; the feed index; the alignment CHECKs; group_name.
db/index.ts        createDb (postgres | pglite+pg_trgm), ensureDatabase, migrate.
db/search/
  index.ts         SearchIndex — THE PGROONGA SEAM: stats / match / score over SearchColumns.
  trgm.ts          v1: LIKE + gin_trgm_ops; bm25-shaped ranking over document slices (fieldSlice).
  pgroonga.ts      the check-5 fallback. Named, not built.
  normalize.ts     the length-preserving fold. Pure. The only fold.
  terms.ts         query -> Term[] (fold, escape, dedupe, cap 8). No floor.
  snippet.ts       raw fields + terms -> [marked] excerpt, best window by term coverage. Pure.
library/
  index.ts         Library: 12 methods, query counts in the contract.
  types.ts         the domain vocabulary; brands ArticleId / EntityKey / Cursor; typed Overview / KbEntry.
  ai-json.ts       lenient AI JSON parse.       cursor.ts   opaque keyset codec.
  articles.ts      feed / detail / content / ai / head — 1 query each.
  search.ts        2 queries; the only composer of SearchIndex; the per-scope SearchColumns views.
  kb.ts            browse (2, was 5), entities (1), entity (1, was N+1), entityHead.   tags.ts / status.ts: 1 each.
api/               schemas.ts (zod), dto.ts (Wire<T>), routes.ts (the chain; AppType).
mcp/               server.ts (10 tools + rm:// resources), present.ts (projections).
spa/               head.ts (paired markers, pure), static.ts (assets + fallback; 404 shell on miss).
import/            cli.ts, run.ts (digest pass -> no-op check -> one transaction, verify before COMMIT),
                   tables.ts, convert.ts (herkules-old's proven core), derive.ts.
content/render.ts  markdown/HTML -> sanitised HTML. A security boundary. RENDER_VERSION.
userinfo.ts        caller's-token profile lookup. To be hoisted into auth-middleware.
```

Tracing `/api/articles?q=` to SQL reads three files: `api/routes.ts` → `library/articles.ts` →
`db/search/trgm.ts`.

### Interface depth

`Library` is twelve methods and hides: keyset cursors; term parsing; ranking; snippet windowing;
jsonb facet cross-filtering; the `status='fetched'` rule that keeps unpublished rows out of every
public answer; and which of two search engines is installed. Each method returns a **complete**
answer (the difference from rm-wenku's `ArticleQuery`, whose `/kb/entities/{name}` ran a five-query
article fetch per result). No `SQL` value and no Drizzle row crosses the boundary in either direction.

`SearchIndex` is three methods over `SearchColumns` (the index never assumes the caller's FROM
clause), and is the FRAME's promised locality: PGroonga is a migration adding an index, an image
change and `SEARCH_INDEX=pgroonga`. Snippets are outside the seam on purpose — pure TypeScript over
raw fields, identical under both engines.

Validation lives at three boundaries: `config.ts` (env, at boot), `api/schemas.ts` + the MCP zod
inputs (strings into domain queries), `import/tables.ts` `checkSource` (a SQLite file we did not
write). Inside, types are trusted; the fold, the terms, the snippet, the cursor codec and the
conversion core are pure functions.

### Access policy, stated because it looks like an omission

**v1 has no writes at all.** No POST/PUT/DELETE and no table an HTTP request could reach
(`import_runs` belongs to the CLI; everything else is truncate-reload cargo). FRAME's "every non-read
requires a member" is vacuously satisfied; `oauth.guard()` protects exactly one route, `/api/me`,
because knowing who you are requires being someone. `/api/viewer` returns `200 null` for nobody so
anonymous page loads never 401. Every MCP call requires a member (`honoAuth(mcp)` on audience
`…/mcp/bbs`); a `mcp/directory` token is refused there with the contract's 401 — done-predicate 4.

### Route table (all GET; anonymous except `/api/me`)

| Route                       | Query / params                                          | Returns                                                       | Library      |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| `/api/articles`             | `q? scope=all\|title\|kb tag? group? cursor? limit≤100` | `Page<ArticleSummary>`                                        | `articles()` |
| `/api/articles/:id`         | ULID                                                    | `Article` \| 404                                              | `article()`  |
| `/api/articles/:id/content` | `format=text\|markdown\|html`                           | raw body + `X-Content-Format`                                 | `content()`  |
| `/api/articles/:id/ai`      | —                                                       | `ArticleAi` (overview + kb + captions; `pending` when absent) | `ai()`       |
| `/api/tags`                 | —                                                       | `TagIndex`                                                    | `tags()`     |
| `/api/search`               | `q` (400 blank) `scope tag group cursor limit`          | `SearchPage` (`score`, `snippet`, `terms`)                    | `search()`   |
| `/api/kb/browse`            | `q? domain? robot? genre? limit≤1000`                   | `KbBrowse` (cards + 3 cross-filtered axes)                    | `kbBrowse()` |
| `/api/kb/entities`          | `q? limit≤500`                                          | `{ items: EntityCount[] }`                                    | `entities()` |
| `/api/kb/entities/:name`    | name or key                                             | `EntityDetail` \| 404                                         | `entity()`   |
| `/api/status`               | —                                                       | `LibraryStatus`                                               | `status()`   |
| `/api/viewer`               | —                                                       | `{ viewer: Viewer \| null }`, 200 anonymous                   | —            |
| `/api/me`                   | —                                                       | `Viewer`; **401 anonymous** (`guard({ role: "member" })`)     | —            |

MCP (`/mcp/bbs`, bearer, member): `search_articles`, `list_articles`, `get_article`, `get_overview`,
`get_kb`, `search_kb`, `list_entities`, `get_entity`, `list_tags`, `library_status`, plus
`rm://articles/{id}[/overview|/kb]` resources. `ask_article` is inference and is out.

### Search, spelled out

- `parseTerms`: whitespace-split, `"` stripped, folded, escaped, de-duplicated, capped at 8. Every
  non-empty term survives.
- `match`: `document LIKE '%t%' ESCAPE '\'` per term, AND-ed. `scope=title` matches the same predicate
  on `substr(s.document, 1, length(s.title))` — the folded title without a SQL fold and without an
  extra index. `scope=kb` uses `kb_search`.
- `score`: bm25-shaped over `fieldSlice(i)`; `stats` is one aggregate query per search (`count(*)
FILTER (WHERE …)` per term, `avg(length(field))` per field).
- `snippet`: over the raw `body_text`, `introduction`, `title` (kb: the ten kb fields); positions found
  on `normalize(field)`, applied to `field`; the field and window with the most distinct terms wins;
  FTS5's `[`, `]`, `…` markers, 60-character radius. `null` when the match came from `author`/`tags`.
- The feed's `q` reuses `match` inside an `EXISTS`, so the list and `/api/search` cannot disagree
  about what a query means.

### Import, spelled out

Digest pass (streams every spec through herkules-old's `convert`/`canonical`/`TableDigest`; this _is_
`--dry-run`) → no-op check against the last `ok` `import_runs` row (equal digests ∧ equal
`RENDER_VERSION` ∧ equal `NORMALIZE_VERSION` → record a `noop` row, exit 0, no transaction) → one
transaction (`TRUNCATE` thirteen tables; per spec in FK order stream 500-row batches, derive
`content_html` / `target_article_id` / `document`, multi-row INSERT) → **read back and verify before
COMMIT** (rows and checksum per table; `content_html IS NOT NULL` wherever `content_raw` is; mismatch →
ROLLBACK) → the `import_runs` row in a separate transaction so a failed run leaves a record. FTS5
virtual tables are read directly (node:sqlite reads them); `users` moves to `SKIPPED` so `checkSource`'s
allowlist still accepts the real dump; `ai_usage.user_id` goes through `--user-map` (unmapped → NULL,
counted).

### Head injection contract

`spa/head.ts` parses the built `index.html` once at boot between `<!--bbs:head-->` and
`<!--/bbs:head-->` (defaults live inside the markers, so the static file is a valid page on its own
and the Vite dev server serves it unchanged); a missing marker throws at boot. `/articles/:id` and
`/kb/:name` render `<title>`, description, canonical and og/twitter tags from `library.head()` /
`entityHead()` — two-column reads, never the full article. Unknown ids serve the plain shell with
**404** so crawlers do not index them. Hashed asset names are irrelevant: the template _is_ the build.

### Tests

PGlite (`pglite://memory`, `extensions: { pg_trgm }`), in CI, no Docker: the migration including both
GIN indexes and both alignment CHECKs; the full import from a fixture `app.db` (rm-wenku's six SQLite
migrations executed with node:sqlite, ~12 seeded articles covering the fold, renderer and user-map
cases), run twice (no-op) and once more with a delta; every `Library` method; search recall, ranking
order and snippet markers; cursor round-trips; the API over `app.request()` anonymous and signed in
(`createFakeIssuer()`; the real auth service via `fetchVia` for the no-consent e2e); MCP over an
in-process SDK client including the wrong-audience 401; head injection against a fixture `index.html`;
the renderer's adversarial cases. Real Postgres, opt-in via `BBS_TEST_DATABASE_URL`: `EXPLAIN` uses the
trigram and feed indexes; postgres.js type parsers agree with `canonical()`. Neither: the 20-query
relevance golden set is `vp run relevance` against `BBS_GOLDEN_DB` (the corpus is not checked in).

### Deploy deltas — the smallest change that works

| #   | Change             | Where                                                               | Smallest form                                                                                                                                                                                                                                                                                                               |
| --- | ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The `bbs` database | nothing in the stack creates one                                    | `ensureDatabase()` at boot (connect to `postgres`, `CREATE DATABASE`, 42P04 = success); `BBS_CREATE_DATABASE=false` opts out for a documented `createdb`.                                                                                                                                                                   |
| 2   | Subdomain          | `tools/deploy/Caddyfile`                                            | a **top-level** `{$BBS_SITE_ADDRESS} { encode zstd gzip; import common_headers; reverse_proxy bbs:3003 }` block — it cannot live under `caddy/services/` (that glob is imported _inside_ the `{$SITE_ADDRESS}` block). Already in the deploy scp list.                                                                      |
| 3   | Platform MCP path  | `tools/deploy/caddy/services/bbs.caddy` (new)                       | `handle /mcp/bbs* { reverse_proxy bbs:3003 }`.                                                                                                                                                                                                                                                                              |
| 4   | Compose            | `docker-compose.yml`                                                | service `bbs` (`PORT 3003`, `PUBLIC_ORIGIN`, `APP_ORIGIN=${BBS_ORIGIN}`, `AUTH_INTERNAL_URL=http://auth:3001`, `DATABASE_URL=…/bbs`, `BBS_CLIENT_SECRET`, `BBS_COOKIE_SECRET`, `WEB_DIR=/app/dist/client`, `./import:/import:ro`, `mem_limit: 384m`, `depends_on` postgres + auth healthy); `caddy.depends_on` gains `bbs`. |
| 5   | Env                | `tools/deploy/.env.example`                                         | `BBS_SITE_ADDRESS` (prod `bbs.herkules.dev`, dev `http://localhost:3003`), `BBS_COOKIE_SECRET` (`BBS_ORIGIN` + `BBS_CLIENT_SECRET` already landed with the issuer change).                                                                                                                                                  |
| 6   | Image              | root `Dockerfile` + `.github/workflows/images.yml`                  | a `bbs` target: build stage adds `@herkules/oauth-client` and `@herkules/bbs` to the ordered list and runs `vp pack` + (round 2) `vp build`; `files: ["dist","drizzle"]` carries both; `ENTRYPOINT ["node","dist/main.mjs"]`, `MIGRATIONS_DIR=/app/drizzle`, healthcheck `wget /healthz`; `matrix.target` gains `bbs`.      |
| 7   | Backup             | `tools/deploy/backup/backup.sh`                                     | loop over `DATABASES="herkules bbs"`, objects `${db}-${stamp}.dump`; compose passes `PGHOST/PGUSER/PGPASSWORD`. The prune is prefix-wide already.                                                                                                                                                                           |
| 8   | Dev                | `apps/bbs/vite.config.ts` (round 2) + `services/web/vite.config.ts` | bbs's Vite server on `:3003` is the app origin and proxies `/api`, `/login`, `/callback`, `/logout`, `/healthz`, `/mcp` to Hono on `:3103`; `services/web`'s dev proxy gains `/mcp/bbs`.                                                                                                                                    |

## Synthesis decision

Two structurally distinct candidates (A: Fable; B: Opus) were sketched from the same grounding, then
cross-judged by a third agent that measured `pg_trgm` on PGlite. Both my scoring and the judge's
picked **B as the base** (judge 20 vs 17; agreement on the base confirms the pick): verify-before-commit
import, one-query reads, `target_article_id` and `document` derived at import, the alignment CHECK, a
search seam over explicit `SearchColumns`, bm25-shaped ranking (what check 5 actually compares against),
`ensureDatabase()`, paired head markers, brands and two presenters.

**Eleven independent agreements**, shipped as consensus: substring recall via `LIKE` + `gin_trgm_ops`
(`similarity()` refused for recall by both); one folded `document` per search table; length-preserving
fold; FTS5 content rows imported verbatim; `content_html` at import, `content_raw` kept, `context_text`
dropped; keyset cursors; the feed expression index; an `import_runs` table (neither the FRAME nor the
grounding suggested it — both invented it); a `SearchIndex` seam with a compiling PGroonga stub; one
`Library`, two presenters; the deploy delta list.

**Grafted from A**: (1) no term floor and no `fts`/`fuzzy` mode; (2) the TypeScript snippet over raw
fields with best-window selection, replacing B's SQL `position()` window; (3) the digest-based no-op
that skips the work (done-predicate 1's wording), keeping B's separate `import_runs` transaction;
(4) `article_tags.group_name` as a generated column; (5) typed `Overview`/`KbEntry`/`ImageCaption`
instead of `Record<string, unknown>`; (6) one `ai(id)` method and `GET /api/articles/:id/ai`;
(7) 404 for unknown ids on the head-injected routes; (8) the two-column `head()`/`entityHead()` reads
(judge's finding: B loaded the whole article to render a `<title>`); (9) A's real `config`/`app`/`main`
files, `package.json` and the build layout; (10) the backup loop and the dev ports.

**Synthesis of my own (neither candidate)**: per-field tf over `substr(document, offset, length(field))`
slices and `scope=title` over the title slice. B's alignment CHECK makes `document` sliceable, so
ranking and the title scope need no SQL fold at all — this removes B's `lower(field)` (a second fold),
A's `bbs_fold()` (a SQL twin the judge showed wraps `lower()` and is not length-preserving) and the
last `lc_ctype` dependence.

**Rejected**: A's SQL `bbs_fold` + generated `doc` columns (two definitions of one invariant, and the SQL
one breaks the length invariant); A's hand-weighted log-tf + `word_similarity` title bonus (the bonus is
0.0 for any Chinese term not at the start of a title); A's after-commit read-back; A's `/api/me/usage`
(a route for a done-predicate over a table with one chat row); B's term floor and `mode` field (see
Tradeoffs); B's SQL `window()`; B's `lower()` in the score; B's 200 on unknown head ids; B's
`?`-placeholder rationale (postgres.js, PGlite and drizzle all emit `$n`; `jsonb_exists()` stays as a
readability choice). Factual fixes applied from the judge: 13 tables / 13 574 rows; `SEARCH_INDEX` exists
in config; FTS5 virtual tables read directly rather than via `_content` shadows.

**The FRAME is amended** on the strength of this: its search sentence becomes "trigram-accelerated
substring conjunction with a computed rank", and its verification list gains `datctype` on the deployed
cluster and `show_trgm('步兵')` returning three trigrams there (pg_trgm's CJK word test runs through
`iswalpha` under the database `LC_CTYPE`; `C.UTF-8`/`en_US.utf8` are fine, `C` might not be).

## Tradeoffs accepted

- **We accept diverging from FTS5 on queries with terms under three characters, in exchange for never
  silently dropping the user's most specific word.** 步兵, 电机, 云台, 底盘 are two characters; FTS5's
  floor threw them away and `mode: "fuzzy"` existed to explain that. Cost: golden-set queries whose FTS5
  top-5 came from the degraded path will differ from ours; the check-5 comparison carries that caveat.
- **We accept a re-import to change the renderer, the normaliser or the link resolver**, in exchange for
  the article read costing one query instead of six plus a sanitiser pass. The import is the sync
  mechanism and runs weekly by design.
- **We accept holding the read-back (~25 MB of values) in memory inside the import transaction**, in
  exchange for a mismatch that rolls back instead of leaving a corrupt corpus live.
- **We accept rewriting ~80 lines of the proven migrator onto `db.transaction()` + `db.execute()`**, in
  exchange for an import test that runs in CI on PGlite. Copying it with `pg` would be cheaper today and
  untested forever.
- **We accept a `document` column that duplicates the search tables' text (~11 MB)**, in exchange for one
  GIN index per table instead of fifteen, one recall predicate, one offset space, and a PGroonga swap
  that is a config change.
- **We accept two identity routes (`/api/viewer`, `/api/me`)**: they answer different questions with
  different failure modes; merging them either 401s every anonymous page load or leaves no member-only
  route.
- **We accept `ensureDatabase()` — an application creating its own database** — in exchange for a first
  deploy that cannot fail on a forgotten `createdb`. Guarded, idempotent, switchable off.
- **We accept `TRUNCATE` blocking readers for ~3 s per import** in exchange for one transaction and no
  staging schema.
- **We accept width folding FTS5 did not do**; it can only add recall relative to the golden set.
- **We accept a copied `userinfo.ts` for the sketch** while naming the hoist as the first implementation step.

## Alternatives considered

- **`similarity()` / `word_similarity()` for recall or ranking, as FRAME's Decision paragraph literally
  says.** Measured unusable for Chinese (0.0 mid-sentence, 0 rows under `%`); it exposes a threshold every
  caller would tune against and changes the result _set_ check 5 measures. Rejected; the FRAME is amended.
- **A SQL fold (`bbs_fold()`) with a TypeScript twin and generated `doc` columns.** Two definitions of one
  invariant tested equal by a fixture, and the SQL one wraps `lower()`, which is not length-preserving.
  Document slices give the same capability with one definition.
- **Per-column `gin_trgm_ops` indexes on the raw columns, no `document`.** Fifteen indexes, an N-way OR
  the library must know the column list for, no single offset space for snippets, and a PGroonga swap
  that becomes a rewrite (PGroonga takes a multi-column index natively; `gin_trgm_ops` does not).
- **Rendering HTML on read, as rm-wenku did.** Same code, strictly more work, and a sanitiser bug becomes
  a reader-facing XSS instead of a failing import.
- **Offset pagination.** No compatibility to keep (fresh contract) and the weekly truncate-reload makes
  offsets address different rows mid-session.
- **A `Library` split into `ArticleQuery` / `KbQuery` / `SearchQuery` objects, mirroring rm-wenku's
  crates.** Three shallow interfaces where one deep one will do; the reader page would coordinate two.
- **Serving the SPA from a second Caddy container, as `services/web` does.** Impossible with head
  injection (it needs a database read), and the FRAME fixed one container.
- **`pg` for the import CLI only.** The cheapest path to a working import and the most expensive to a
  tested one; a third driver in a repo that deliberately has two.

## Changes outside this package

1. Hoist `userinfo.ts` into `@herkules/auth-middleware/userinfo` (a subpath next to hono/mcp/testing)
   and delete the copies in `services/mcp-directory` and here — first implementation step.
2. `packages/oauth-client/DESIGN.md` usage sample: `/api/me` returns null → `/api/viewer` returns null,
   `/api/me` is guarded (one line).
3. `apps/bbs/FRAME.md`: the search sentence and the verification list, as above.
4. The deploy files in the table above; `services/web/vite.config.ts` gains the `/mcp/bbs` proxy line.

## Open questions and risks

1. **Search fidelity vs product (Tradeoff 1).** Dropping FTS5's three-character floor is a deliberate
   deviation that check 5 will register on short-term golden queries. Acceptable, or should the golden
   set be chosen from queries whose terms are all ≥ 3 characters so the gate measures ranking rather than
   this decision?
2. **`ensureDatabase()` at boot vs a documented `createdb`.** The app holds CREATEDB (the compose role is
   the container's superuser anyway); the alternative is one ops step and one more thing to forget.
3. **Risk: `renderArticleHtml` is a security boundary re-implemented in another language.** It gets its own
   adversarial test file and runs at import (a failure is a failed import), but a permissive allowlist is
   an XSS in the reader.
4. **Risk: the feed keyset predicate.** The explicit three-clause OR chain always indexes; the
   row-comparison form may or may not. One `EXPLAIN` on real Postgres decides, before implementation
   commits to either.
5. **The golden set does not exist yet.** Capturing 20 real queries with FTS5 top-5 from the old box is a
   prerequisite for check 5 being falsifiable at all.

## Next implementation step

Hoist `userinfo` into auth-middleware, then `db/schema.ts` + `drizzle/0000_*.sql` (with the hand-added
`pg_trgm` line) and one PGlite test that migrates, inserts one `article_search` row through
`buildDocument`, asserts `document LIKE '%步兵%'` uses the GIN index's semantics (returns the row) and that
the alignment `CHECK` rejects a hand-corrupted `document` — proving the extension loads, the index
creates, and the invariant the whole search design rests on is enforced by the database before any
query exists.
