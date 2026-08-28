# BBS web UI

`apps/bbs/web` is the read-only React SPA at `https://bbs.herkules.dev`: feed, ranked search, reader, knowledge base, tags, status and account. It is a static build — `vp -C web build` emits `apps/bbs/dist/client`, and the Hono container serves those files with per-route head injection (`../src/spa/static.ts`, `../src/spa/head.ts`). There is no build-time API base URL: the browser's origin is the app origin.

The SPA build is separate from the package's `vp pack`. Two Vite configs, two tsconfigs, no shared `root`.

## Run and test

```sh
vp run dev      # Hono on :3103
vp run dev:web  # = vp -C web dev — Vite on :3003
vp test
vp check
vp run build    # vp pack -> dist/main.mjs, then vp -C web build -> dist/client
```

In development the Vite server on :3003 **is** bbs's origin; it proxies `/api`, `/login`, `/callback`, `/logout`, `/healthz` and `/mcp` to the Hono process on :3103 (`vite.config.ts`). Head injection is therefore never exercised in dev, which is why the server tests cover it directly (`../tests/head.test.ts`, `../tests/spa.test.ts`).

## Ownership

- `src/routes.tsx` is the URL contract and the data dependency of every screen — the browser-side `app.ts`. Read it to answer "what does URL X load". It owns search validation, loaders, the hover-gated AI prefetch, the blank-`/search` redirect, scroll restoration, and the pending / error / not-found triage.
- `src/api/client.ts` is the only adapter over `hc<AppType>`. It turns the `{ error, error_description }` envelope into an `ApiError` and a 404 into `null` on exactly three routes — article, ai, entity — where a missing id is data; everywhere else a 404 throws. `fetch` is injectable so the contract test drives the real Hono app in process.
- `src/api/queries.ts` is the only query-key factory. Keys are `["bbs", kind, ...args]`, cache policy lives with the key, and `q` travels in the router context rather than a module singleton.
- `src/url.ts` owns every search-param schema. Nothing else parses `location.search` and nothing builds a query string by hand.
- `src/shell/` owns the chrome: header, nav, footer, the three-state theme, and `usePageTitle`.
- `index.html` carries the head-injection contract with `../src/spa/head.ts`. The defaults live _inside_ the `<!--bbs:head-->` / `<!--/bbs:head-->` markers so the file is a complete page on its own (what the dev server serves) and the server replaces the whole block for `/articles/:id` and `/kb/:name` — it never merges tags, and a missing marker is a boot failure. The pre-paint theme script sits deliberately outside the markers; `tests/index-html.test.ts` pins it against `THEME_BOOT_SCRIPT` in `src/shell/theme.ts`.

## Decisions that bind

- Loaders fetch; screens read the same key back with `useSuspenseQuery` and carry no pending or error branch. `useQuery` survives only for the two reads that are genuinely optional and render without their answer: the reader's AI panel and the header's account chip.
- Every child route carries its own `errorComponent`. The root deliberately has none, so a failed screen never replaces the header. A `null` from one of the three 404-as-data routes renders `shell/NotFound`, not an error.
- `/` and `/search` share a canonical search middleware: `stripDerived` drops `scope=all` and a `group` that is just `groupOf(tag)`, so an href never shows what the schema already knows. `groupOf` mirrors the generated `article_tags.group_name` — `split_part(tag, '/', 1)`, everything before the _first_ slash.
- `usePageTitle` sets the same string the server injected (`article.title`, not a parsed title part), so a deep link's first paint keeps the injected `<title>` while client navigations update it. The root never touches `document.title`.
- Response bodies are trusted as `Wire<T>`: one repo compiles both ends, `AppType` is the contract, and `../tests/rpc.test.ts` is where the compile-time claims are pinned. Only the error envelope is parsed.
- Colour and typography tokens are `services/web`'s verbatim, so bbs and herkules.dev read as one family; only `--body` differs, for the CJK stack this corpus needs. No self-hosted fonts.
- Theme is three-state: system is the default, and the header toggle cycles 跟随系统 → 浅色 → 深色 into `localStorage["bbs:theme"]`, expressed as `data-theme` on `<html>`. System is the _absence_ of the attribute and of the stored value, so today's default is never frozen into a reader's browser. Dark tokens are declared twice — a `prefers-color-scheme` block guarded as `:root:not([data-theme="light"])` and a `:root[data-theme="dark"]` block — because neither alone wins in both directions.
- Styling is one cascade: `src/styles.css` (tokens, primitives, shell) plus one sheet per area, imported by that area's page module. Vite emits a single stylesheet; the split only keeps several authors out of one file.
- The reader runs regex passes over the server's already-sanitised HTML (`src/reader/prose.ts`) rather than shipping a DOM parser. The passes only insert `id`, `alt` and local `href` values, all escaped.
- The MCP guide's URL is the build-time `__PUBLIC_ORIGIN__` define, not an API round trip: it changes with the deployment, not the session.
- `/api/kb/entities` has no SPA consumer — it serves the MCP `list_entities` tool — and `/api/me` is never called, because `q.viewer()` answers the same question without a 401.

## Tests

Node environment, no DOM library. Screens are `(params, search, data) → JSX` over tested pure modules, so `renderToString` smoke renders of the router-free leaves buy the crash coverage for no new infrastructure; a behaviour that needs events is the trigger for adding a DOM harness. Test files are `.ts` built with `createElement` because the package's `test.include` is `web/tests/**/*.test.ts` — a `.tsx` file would not be collected.

- `contract.test.ts`: every `q.*` against the real Hono app (PGlite, fixture corpus) through `fetchVia` — 404 as `null`, a malformed id as an `ApiError`, cursor paging to exhaustion, anonymous vs signed-in viewer, facets that never contain their own filter.
- `url.test.ts`: the four schemas' defaults, `groupOf` / `leafOf`, `stripDerived`.
- `index-html.test.ts`: `index.html` embeds `THEME_BOOT_SCRIPT` and keeps the marker block in order after it, compared whitespace-insensitively because oxfmt reindents inline scripts.
- `theme.test.ts`: the pure theme functions over fake storage and a fake root, plus the boot script parsed through `node:vm`.
- `prose.test.ts`, `kb-model.test.ts`, `snippet.test.ts`, `format.test.ts`, `ai.test.ts`, `title.test.ts`, `loginError.test.ts`: the pure modules behind the screens.
- `render-shell.test.ts`, `render-feed.test.ts`, `render-kb.test.ts`, `render-reader.test.ts`: smoke renders of the leaves. Router-bearing components have none — they need a `RouterProvider`, and `contract.test.ts` covers their data.

## Page rendering

Why the document is static and what the server injects into it is in [`../README.md`](../README.md#page-rendering), which also records that TanStack Start was evaluated and not adopted.

## Code map

- `src/routes.tsx`: the route tree, loaders and per-route search schemas
- `src/url.ts`: search-param schemas and canonical-href helpers
- `src/api/client.ts`, `src/api/queries.ts`: the RPC adapter and the query keys
- `src/shell/`: chrome, theme, skeletons, error and not-found screens
- `src/feed/`, `src/search/`, `src/reader/`, `src/kb/`, `src/tags/`, `src/status/`, `src/about/`, `src/account/`: one directory per screen area, pure logic beside its views
- `src/lib/`: Shanghai dates and counts, AI labels, excerpt cleaning
- `index.html`, `vite.config.ts`, `tsconfig.json`: the document and its markers, the SPA build and dev proxy, the DOM type program
