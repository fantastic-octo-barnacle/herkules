# `apps/bbs/web` — design, round 2: the SPA

Round 1 (committed: `cf54328`, `5044f62`, `a022dc6`) fixed the server: `AppType` (`src/api/routes.ts`,
every query string and path param through `@hono/zod-validator`, so `hc<AppType>` types its inputs),
the `Wire<T>` DTOs (`src/api/dto.ts`; only brands erased, literal unions kept — pinned by
`tests/rpc.test.ts`), snippet **segments** on the wire, the head-marker contract (`src/spa/head.ts`) and
the dev topology. This round designs what runs in the browser against that contract. Bodies are
`not implemented`; the sketch is embedded below rather than checked in as `.tsx` because the package's
`tsconfig.json` has no `include`, so any `web/src/*.tsx` would join the server's type program today
(`--jsx` unset, `react` unresolved) and break `vp check`. The tsconfig split is the first proposed diff.

## Problem

Port rm-wenku's React SPA (eight screens, 2 700 lines of hand-written CSS, react-router v8 +
TanStack Query, OpenAPI-generated types) onto TanStack Router + Query and `hc<AppType>`, read-only,
on `bbs.herkules.dev`. What makes the shape non-obvious:

- **The old SPA never used ranked search.** Its search box filtered the date-ordered feed; the
  FTS5 relevance endpoint sat unused. Round 1 built `/api/search` with snippets on purpose, so this
  round decides what the search box does.
- **rm-wenku's URL handling was three things pretending to be one**: `listState.ts` parsed search
  params, `browseHref()` built them, and `SearchBar` synced the URL into local state during render.
  TanStack Router's `validateSearch` + typed `<Link search>` exist to collapse exactly that.
- **Every rm-wenku page re-implemented the pending / error / not-found triage** (404 → `null` from
  `apiGet`, `isError`, `isPending`) — eight copies of one decision.
- **The look must read as herkules.dev's** (services/web: engineering-paper neutrals, green accent,
  system fonts, `prefers-color-scheme` dark) while rm-wenku's layout — reader grid with a sidebar that
  becomes a bottom sheet, datasheet-style mono metadata, KB card grid — is the proven fit for the
  content.
- **Round 1 serves the shell**: unknown ids already come back as a 404 document; the SPA's not-found
  screen is a rendering, not a discovery. Login/logout are full-page navigations owned by
  `@herkules/oauth-client` (`GET /login?next=`, `POST /logout`); `/api/viewer` is `{ viewer: null }`
  for nobody.
- **No DOM test harness exists in the repo.** `services/web` tests pure modules and drives the real
  auth service in-process; it renders nothing.

## Usage (caller's view)

### Developer, day one

```console
$ vp run dev            # Hono on :3103 (node --watch)
$ vp run dev:web        # = vp -C web dev: Vite on :3003, the app origin; proxies /api /login /callback /logout /healthz /mcp
$ vp run build          # vp pack -> dist/main.mjs ; vp -C web build -> dist/client
$ vp test               # server tests + web/tests (pure modules, view smoke renders, the hook contract test)
```

### A screen (the reader)

```tsx
// web/src/reader/ArticlePage.tsx — no pending branch, no error branch; hooks run unconditionally.
export function ArticlePage() {
  const { id } = articleRoute.useParams();
  const { q } = articleRoute.useRouteContext();
  const { data: article } = useSuspenseQuery(q.article(id)); // the loader already ensured it
  const { data: ai } = useQuery(q.ai(id)); // prefetched by the loader on real navigations
  const prose = useMemo(() => (article ? prepareProse(article) : null), [article]);
  usePageTitle(article?.titleParts.topic ?? null);
  if (!article || !prose) return <NotFound what="article" />; // null is data: the server said 404
  …
}
```

```tsx
// web/src/routes.tsx — the URL contract and the data dependency of every screen, in one file.
export const articleRoute = screen({
  path: "/articles/$id",
  loader: ({ context: { queryClient, q }, params, cause }) => {
    // Hover preloads run this loader too; the AI read is only worth issuing on a real navigation.
    if (cause !== "preload") void queryClient.prefetchQuery(q.ai(params.id));
    return queryClient.ensureQueryData(q.article(params.id));
  },
  pendingComponent: ReaderSkeleton,
  component: ArticlePage,
});
```

### Navigation is typed; the URL is the only state

```tsx
<Link to="/" search={(s) => ({ ...s, group: "机械", tag: undefined })}>机械</Link>
<Link to="/search" search={{ q, scope: "all" }}>搜索</Link>
<Link to="/kb" search={(s) => ({ ...s, domain: card.domain[0] })}>{card.domain[0]}</Link>
<Link to="/articles/$id" params={{ id: link.articleId }}>{link.label}</Link>
```

A typo in a param or a search key is a compile error at both ends: `<Link search>` here, and
`client.api.articles.$get({ query })` in `client.ts` (round 1's validators are what give `hc` its input
types; `tests/rpc.test.ts` pins a typo'd key and a missing `q` as `@ts-expect-error`).

### Identity

```tsx
// AccountChip — renders nothing until the answer is known, so a signed-in user never sees 登录 flash.
const { data } = useQuery(q.viewer());
if (data === undefined) return null;
return data.viewer ? (
  <form method="post" action="/logout">
    <input type="hidden" name="next" value={here} />
    <button>退出</button>
  </form>
) : (
  <a href={`/login?next=${encodeURIComponent(here)}`}>登录</a>
);
```

## Shape

### Data structures first

1. **URL state is a typed, validated object per route** (`web/src/url.ts`, zod schemas passed to
   `validateSearch`). One base `filter` object (`q?`, `scope`, `tag?`, `group?`) is shared by `/`,
   `/search` and `/kb`'s `q`; the route schemas are projections of it (`feedSearch`, `rankedSearch`,
   `kbSearch`, `accountSearch`), and `group` defaults from `groupOf(tag)` in exactly one transform.
   Nothing else in the SPA parses `location.search`, and nothing builds a query string by hand. Per
   boundary-discipline: the URL is the untrusted input; every screen reads a parsed value.
2. **One query-key factory, `createQueries(api)` → `q`** (`web/src/api/queries.ts`): nine
   `queryOptions` / `infiniteQueryOptions` factories, keys `["bbs", <kind>, <args>]`. `q` travels in
   the **router context** next to `queryClient` (no module singleton), so loaders, screens
   (`route.useRouteContext()`) and the contract test all go through one instance built from one
   `BbsApi`. Cache policy lives with the key: feed 10 min so returning from an article keeps the list;
   viewer 30 s + `refetchOnWindowFocus`; `placeholderData: keepPreviousData` on the three filtered
   lists so a chip click re-renders over the previous page instead of flashing empty (this repo has
   already fixed one loading flicker, `44fc929`).
3. **The API client is a small typed adapter over `hc<AppType>`** (`web/src/api/client.ts`):
   `BbsApi` with one method per route the SPA uses, returning the `Wire<T>` DTOs. Query-input types
   are `InferRequestType<…>["query"]` off the client (real since the validators landed). It owns the
   two policies rm-wenku spread around: `ApiError` from the `{ error, error_description }` envelope,
   and **404 → `null`** on exactly the three routes where a missing id is data (article, ai, entity).
   `fetch` is injectable, so the contract test drives the real Hono app via `app.request`.
4. **Domain values arrive as DTOs and stay DTOs.** No client-side re-typing layer: `ArticleDTO` etc.
   are imported type-only from `../../src/api/dto.ts`; literal unions (`role`, `ai.status`,
   `link.kind`, `contentFormat`) survive the wire, so `AiOverview`'s status branch and the
   管理员/成员 branch are exhaustive. Presentation-only derivations are pure functions in `lib/`.
5. **Snippets are segments on the wire** (`SearchHit.snippet: SnippetSegment[] | null`, round 1):
   the SPA renders `{ text, hit }` as text and `<mark>`; it never parses brackets out of forum prose.

### Route tree (`web/src/routes.tsx`, code-based, one file — the browser-side `app.ts`)

| Path            | Search (validated)               | Loader ensures                                      | Screen                |
| --------------- | -------------------------------- | --------------------------------------------------- | --------------------- |
| `/`             | `FeedSearch`                     | `q.tags()`, first page of `q.feed(s)`               | `feed/FeedPage`       |
| `/search`       | `RankedSearch` (blank `q` → `/`) | first page of `q.search(s)`                         | `search/SearchPage`   |
| `/articles/$id` | —                                | `q.article(id)`; prefetch `q.ai(id)` unless preload | `reader/ArticlePage`  |
| `/kb`           | `KbSearch`                       | `q.kbBrowse(s)`                                     | `kb/KbPage`           |
| `/kb/$name`     | —                                | `q.entity(name)`                                    | `kb/EntityPage`       |
| `/tags`         | —                                | `q.tags()`                                          | `tags/TagsPage`       |
| `/status`       | —                                | `q.status()`                                        | `status/StatusPage`   |
| `/about`        | —                                | —                                                   | `about/AboutPage`     |
| `/account`      | `AccountSearch`                  | `q.viewer()`                                        | `account/AccountPage` |

Anything else: the root's `notFoundComponent` (`shell/NotFound`) inside the shell. Root route:
`shell/App` (header: wordmark, nav 文章 / 知识库 / 标签 / 状态 / 关于, `AccountChip`; `<Outlet/>`;
footer) and `notFoundComponent` only — **`errorComponent` sits on every child route** (via the
`screen()` helper) so a failed `/status` fetch replaces the page, not the header. Router options:
`scrollRestoration: true` (replaces rm-wenku's `sessionStorage` anchor hack), `defaultPreload: "intent"`

- `defaultPreloadStaleTime: 0` (hovering a row prefetches the article through React Query's cache;
  the reader opens from cache), `defaultPendingMs: 300` / `defaultPendingMinMs: 300` (skeletons show
  only when a load is actually slow, and never for a single frame), `context: { queryClient, q }`.

### Module map

```
web/index.html                  the shell; <!--bbs:head--> block (the round-1 contract)
web/public/{favicon.svg,robots.txt}
web/vite.config.ts              SPA build + dev proxy (separate from the pack config; see diffs)
web/tsconfig.json               DOM + react-jsx + node types; the server tsconfig excludes web/
web/src/env.d.ts                declare const __PUBLIC_ORIGIN__ (vite `define`)
web/src/main.tsx                QueryClient, api, q, router; renders at module top level
web/src/routes.tsx              the tree above. Read this to answer "what does URL X load".
web/src/url.ts                  filter base + the four route schemas + groupOf(tag). Pure.
web/src/api/client.ts           BbsApi over hc<AppType>; ApiError; 404 -> null policy. fetch injectable.
web/src/api/queries.ts          createQueries(api) — the only query keys and cache policies.
web/src/shell/                  App (chrome), RouteError, NotFound, Skeletons, AccountChip, usePageTitle
web/src/feed/                   FeedPage, ArticleRow, CategoryTabs, SearchBar, LoadMore (IO + button)
web/src/search/                 SearchPage (ranked hits), Snippet (segments -> <mark>)
web/src/reader/                 ArticlePage, Prose, Toc, ReaderSidebar (sheet ≤ 960px), AiOverview,
                                KbPanel, Resources, Lightbox; prose.ts (headings/local links/alts). Pure + tested.
web/src/kb/                     KbPage (facets + cards + pitfalls + entities), EntityPage; model.ts (pure, ported)
web/src/tags/ status/ about/ account/   one page each; account/loginError.ts (pure)
web/src/lib/                    format.ts (Asia/Shanghai dates, 字/链接/图 counts, link kinds),
                                ai.ts (maturity class, genre section labels, hasContent), title.ts (cleanExcerpt)
web/src/styles.css              tokens (services/web's) + primitives + the ported layouts
web/tests/*.test.ts             pure modules; render.test.ts (renderToString smoke); contract.test.ts (q.* vs the real app)
```

Tracing "what happens when I open `/kb?domain=算法`" reads three files: `routes.tsx` → `queries.ts` →
`kb/KbPage.tsx` (and `kb/model.ts` for the derived sections).

### Interface depth

`q` + `client.ts` hide: the RPC client, the wire envelope, which routes treat 404 as data, cache
lifetimes and placeholder policy, cursor paging (`getNextPageParam`), and the app origin. `routes.tsx`
hides: search-param validation, the blank-search redirect, prefetching and its hover gate, scroll
restoration and the pending/error/not-found triage (route-level `pendingComponent` /
`errorComponent` / root `notFoundComponent`). What a screen is left with is rendering a known-good
value. rm-wenku's screens each carried the triage, the URL parsing and the href building; here a
screen is a function of `(params, search, data)`.

Validation lives at two boundaries: the URL (`url.ts`) and the wire (`client.ts` checks the error
envelope; response bodies are trusted as `Wire<T>` because the same repo compiles both ends —
`AppType` is the contract, and `tests/rpc.test.ts` is where that claim is pinned).

### Screens, what each keeps from rm-wenku and what changes

- **Feed `/`**: search box + scope buttons 标题 / 全文 / 知识库, category tabs (群组 + sub-tag chips
  with counts from `q.tags()`), rows (pin / season / team / labels eyebrow, `titleParts.topic`
  headline, mono meta `YYYY-MM-DD · author · N 字 · N 链接 · N 图`, tag chips, excerpt), infinite
  scroll with an `IntersectionObserver` sentinel and a 加载更多 fallback. **Change**: the search box
  submits to `/search` (ranked); the feed's own `q` remains as a filter, reached from `/search` via
  "按发布时间排列" so both round-1 endpoints have a screen.
- **Search `/search`**: ranked hits = the feed row plus a snippet line (`<mark>` on hits) and the
  echoed `terms` as chips ("已搜索：步兵 底盘"). A bare or blank `/search` redirects to `/` with the
  same filters (`beforeLoad`), so the empty search box the old product allowed is not an error page.
  Scope/tag/group filters shared with the feed. Cursor "load more" identical to the feed (both are
  `infiniteQueryOptions`).
- **Reader `/articles/$id`**: `contentHtml` via `dangerouslySetInnerHTML` after `prepareProse()`
  — ported regex passes over the trusted string: fill empty `alt` from `images[]`, rewrite `<a>` whose
  `href` matches a link with `articleId` to `/articles/{id}` **keeping the other attributes** (the old
  pass dropped `rel`), lift a leading `<h1>` to the deck line, assign `id="sec-N"` to h2/h3 for the TOC
  (rendered at ≥ 2 headings). Internal links are intercepted by a delegated click handler and routed
  through the router (no full reload). Lightbox: native `<dialog>`, delegated click on `.prose img`.
  Sidebar: 目录 / AI 概览 / 规格 / 资源; ≤ 960 px a bottom sheet with a fixed dock; Esc closes. AI
  panel: `q.ai(id)` — `pending` renders "尚未生成" **without polling** (the generator is on the old
  box; there is nothing to wait for); `failed` renders the error line; `ready` renders overview with
  genre-adaptive section labels (`lib/ai.ts`), KB panel only when `hasContent(kb)` (so the dock button
  is gated on content, fixing the empty-规格 bug), captions from `images`. Meta strip: 查看原文 ↗
  (`rel="noopener noreferrer"`), tag chips → `/?tag=`. Dropped: `refreshRequestedAt` note, chat dock.
- **KB `/kb`**: facets 体裁 / 领域 / 兵种 as typed `<Link search>` chips (each axis is counted
  under the other filters — the server's invariant, the chips just render it), cards, the round-robin
  pitfall feed (≤ 14) and entity tallies (常见条目 / 全部条目) from the ported `kb/model.ts` over the
  cards' `entities` — `/api/kb/entities` therefore has **no SPA consumer** (it serves MCP
  `list_entities`); the KB search box goes to `/search?scope=kb`. Cards link to the reader;
  domain/robot/genre chips back to `/kb`; entity chips to `/kb/$name`.
- **Entity `/kb/$name`**: header (name, N 篇), then `entitySections()` — 参数对比 table,
  其他参数, 作为组件, 相关取舍, 相关踩坑 — over `articles[].kb`. `null` → 条目不存在.
- **Tags `/tags`** (new, cheap): groups with counts, tags under each; every chip links to `/`.
- **Status `/status`**: three tiles (文库 / AI 概览 / 抓取) from `LibraryStatus` plus "本库导入于 …"
  — static; no SSE, no console, no clock skew.
- **Account `/account`**: signed out → 登录 panel (`<a href="/login?next=/account">`) + MCP guide
  (`claude mcp add --transport http rm-wenku ${__PUBLIC_ORIGIN__}/mcp/bbs` — the platform origin, a
  build-time `define` constant from `PUBLIC_ORIGIN`, default `https://herkules.dev`); signed in →
  avatar, display name, 管理员/成员 (exhaustive over `role`), sign-out form. `login_error` →
  `loginErrorText()`: a `Partial<Record<LoginFailureCode, string>>` for the five known codes and one
  default line for the issuer's own codes (`access_denied`, …) — the union is deliberately open
  (`string & {}`), so exhaustiveness is not available and not claimed. No PATs, no quota line.
- **About**: rewritten copy (what this is, how search works, MCP, disclaimer).
- **Not found**: one component, used by the root `notFoundComponent` and by screens whose query
  returned `null`.
- **Titles**: each screen calls `usePageTitle(x)` (`document.title = "${x} · RM 文库"`, `null` = site
  default) with the same value the server injected, so the first paint of `/articles/:id` keeps the
  injected `<title>`; the root never sets or resets it.

### Styling

One cascade, `web/src/styles.css` (tokens, primitives, shell) plus one sheet per screen area imported by
its page module — Vite bundles them into a single stylesheet, so the datasheet idiom is still one
cascade; the split only keeps four authors out of one file. Tokens are **services/web's** (`--paper
--surface --ink --muted --line --accent --mono --radius`, no self-hosted fonts) so bbs and herkules.dev
read as one family; the CJK stack is added to `--body`. **Theme is three-state** (decided at the
checkpoint, 2026-08-28): system is the default, and a header toggle cycles 跟随系统 → 浅色 → 深色,
persisted as `localStorage["bbs:theme"]` and expressed as `data-theme="light" | "dark"` on `<html>`
(absent = system). Dark tokens are defined twice — under `@media (prefers-color-scheme: dark)` guarded
as `:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]` — so the override wins in
both directions. A four-line inline script in `index.html` (outside the head-marker block) applies the
stored value before first paint; `shell/theme.ts` (pure: `nextTheme()`, `readTheme()`, `applyTheme()`)
and a `useTheme()` hook own it afterwards. Layout rules are
**ported from rm-wenku's** browse / reader / sidebar / ai / kb sheets and re-tokened: the datasheet
idiom (mono metadata lines, bracketed hover on rows, the 960 / 720 px breakpoints, the bottom-sheet
sidebar). `<meta name="color-scheme" content="light dark">` in the shell (the inline script also sets
`style.colorScheme` on the override so form controls follow); `.prose` gets the reader
typography and `img { max-width: 100% }`. Reduced motion respected as services/web does.

### Head-marker contract (`web/index.html`)

The block between `<!--bbs:head-->` and `<!--/bbs:head-->` holds the defaults (`<title>RM 文库</title>`,
description, `og:site_name`, `og:type=website`) so the file is a complete page for the Vite dev server,
and round 1 replaces the whole block for `/articles/:id` and `/kb/:name`.

### Proposed diffs to existing files (not applied here)

`apps/bbs/package.json` — dependencies: `react`, `react-dom`, `@tanstack/react-router`,
`@tanstack/react-query`; devDependencies: `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`;
scripts: `"dev:web": "vp -C web dev"`, `"build": "vp pack && vp -C web build"` (`vp build` takes a
positional `ROOT` and the global `-C <DIR>`; there is no `-c`/`--config`). Version floors to confirm at
install, since the sketch relies on both: `QueryClient.ensureInfiniteQueryData` (React Query v5, not
the earliest 5.x) and `createRouter({ scrollRestoration })` (Router v1, recent). `files: ["dist", "drizzle"]`
already carries `dist/client`.

`apps/bbs/tsconfig.json` — add `"exclude": ["web", "dist", "node_modules"]`. New `web/tsconfig.json`
copies services/web's: `jsx: react-jsx`, `lib: [ES2023, DOM, DOM.Iterable]`, **`types: ["vite/client", "node"]`**
(the type-only import of `routes.ts` still adds `src/db/index.ts` and `src/library/cursor.ts` to the
program, and those name `node:url`, `process` and `Buffer`; without `"node"` that is four TS2591s),
`moduleResolution: bundler`, `include: ["src", "tests", "vite.config.ts"]`. The two tsconfigs are
unrelated projects: the first thing to confirm is that `vp check` type-checks the `web/` program at all
— if it only follows the package tsconfig, add `references` or a second check step, because the
compile-time contract story depends on someone running the checker over `web/`.

`apps/bbs/vite.config.ts` — `test.include` becomes `["tests/**/*.test.ts", "web/tests/**/*.test.ts"]`.
Nothing else: `pack` stays as it is.

New `apps/bbs/web/vite.config.ts` (Vite's `root` defaults to `process.cwd()`, never to the config
file's directory — `-C web` makes them agree, and `root` is set explicitly so a bare `vite` from the
package root agrees too):

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const HONO = "http://localhost:3103";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 3003, // APP_ORIGIN in dev: this server IS bbs's origin
    strictPort: true,
    proxy: Object.fromEntries(
      ["/api", "/login", "/callback", "/logout", "/healthz", "/mcp"].map((p) => [p, HONO]),
    ),
  },
  build: { outDir: "../dist/client", emptyOutDir: true, sourcemap: false },
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify(process.env.PUBLIC_ORIGIN ?? "https://herkules.dev"),
  },
});
```

Root `Dockerfile` (`bbs` target, landed in `a022dc6`): the build stage runs `vp run build` in
`apps/bbs`, so `dist/main.mjs` and `dist/client/` land together; `WEB_DIR=/app/dist/client`.
`services/web/vite.config.ts` gains `"/mcp/bbs": "http://localhost:3103"` (round-1 deploy delta 8).

### Tests (`web/tests`, node environment, no DOM library)

- Pure modules, ported with their rm-wenku tests: `url.test.ts` (schemas, `groupOf`, the blank-`q`
  case), `prose.test.ts` (alt fill, local-link rewrite keeps `rel`, lead heading, heading ids),
  `kb-model.test.ts` (round robin, entity tallies, sections), `format.test.ts` (Shanghai dates, counts),
  `snippet.test.ts` (segment trimming keeps every hit), `loginError.test.ts` (known codes + default).
- `render.test.ts` — `react-dom/server.renderToString` smoke renders of `ArticleRow`, `Snippet`,
  `AiOverview` (all three statuses) and `KbPanel` over fixture DTOs: no happy-dom, no Testing Library,
  and it catches a crashing component and the `hasContent` gate. Adopted from the independent review.
- `contract.test.ts` — the hook layer without React: `createTestBbs({ importFixture: true })` from
  `tests/helpers.ts`, `createApi({ origin: "http://bbs.test", fetch: fetchVia(bbs.app) })`, a bare
  `QueryClient`, and `queryClient.fetchQuery(q.article(id))` / `fetchInfiniteQuery(q.feed(...))` for
  every factory: asserts the 404 → `null` routes, cursor paging over the fixture to `nextCursor: null`,
  `viewer` null anonymous and a `Viewer` after `signIn()`, and that facet counts never contain their own
  filter. Compile-time claims are pinned once, in round 1's `tests/rpc.test.ts` (typo'd key, missing
  `q`, bad scope); this test does not repeat them. A **blank** `q` is a runtime 400 the route never sends
  (the `/search` redirect), not a type error.
- Deliberately absent: DOM-driven component tests. Screens here are `(params, search, data) → JSX`
  over tested pure modules; the smoke renders cover "does it render", and a behaviour that needs
  events is the trigger for adding a DOM harness.

## Synthesis decision

Two candidates, structurally distinct: **A** — router-owned data (file-based routes with the Vite
plugin and a generated `routeTree.gen.ts`, loaders + `validateSearch`, Suspense, services/web tokens,
a hook contract test); **B** — screen-owned data (rm-wenku transliterated: code-based route tree,
`useQuery` with per-page triage, `listState.ts` + href builders, the nine stylesheets, manual dark
toggle, self-hosted fonts, sessionStorage scroll anchor, as-built date-ordered search). The fork
rules forbade spawning runner agents, so both candidates and the first judge pass were authored by
this fork (`scratchpad/bbs/spa/{candidate-A,candidate-B,JUDGE}.md`).

**Base: A** (5 axes to 2 — depth of the screen interface, one source of truth for the URL, no
waterfalls, uses the ranked endpoint, has a contract test). **Grafted from B**: the manual theme toggle (re-added at the checkpoint on top of the
system default — light may be more familiar to the audience); the code-based route
tree in one file (drops A's Vite plugin and generated file while keeping `validateSearch`, loaders,
typed `Link`s — code-based routes support all of them); the pure modules (`kb/model`, `prose`,
`format`, `ai`, `title`) with their tests; the layout CSS for browse / reader / kb (structure only,
re-tokened). **Rejected from B**: per-page triage; URL parsing in two places; IBM Plex Mono self-hosting; the scroll-anchor hack (router scroll
restoration); search that ignores `/api/search`. **Rejected from A**: file-based routing.

**Independent review** (`scratchpad/bbs/spa/OPUS-REVIEW.md`, a second model against the compiled
`AppType`): verdict "adopt with changes; the architecture is right", plus an alternative shape —
`Screen<S, D>` objects (`path`, `search`, `load`, a pure `view()` view-model, `Component`) with a
generic `routeOf()` turning a `SCREENS` list into the tree, one `Filter` domain object instead of four
schemas, co-located CSS modules, and `view()` unit tests + `renderToString` smoke tests. **Adopted**:
the `renderToString` smoke tests (zero infra, real coverage); one shared `filter` base schema with the
route schemas as projections; the `screen()` helper that applies `errorComponent` per child route;
`q` in the router context instead of a module singleton; the `cause`-gated AI prefetch;
`placeholderData: keepPreviousData` on the filtered lists; the bare-`/search` redirect; explicit
`defaultPendingMs`; dropping `entities()` from `BbsApi`. **Rejected**: the `view()` layer (a
pass-through on `/about`, `/tags`, `/status` and `/account` — the red-flag test — and a second place
that knows the DTOs; the pure modules already are the testable half of each screen); the generic
`routeOf()` over a `SCREENS` list (the explicit tree is ten routes and reads as the table above; the
generic version hides `loaderDeps`/`beforeLoad` behind a conditional spread); CSS modules (the
datasheet idiom is one cascade by design — mono meta lines, bracket hover, breakpoints — and a single
sheet is the product's identity, as both rm-wenku and services/web chose). Every compile/tooling
defect the review found was real and is fixed in this revision (query-input types, `Wire<>` literals,
`web/tsconfig` `types`, `vp -C`, Vite `root`, `innerType()`, the conditional hook, the viewer
envelope, the `@ts-expect-error` claim, the two `createApi` signatures, `LoginFailure` exhaustiveness,
the stale snippet request); three of them (`zValidator` inputs, `Wire<>` literals, `LoginFailureCode`)
were resolved in round 1 rather than here.

## Tradeoffs accepted

- **We accept no DOM-driven component tests** in exchange for zero new test infrastructure; the
  contract test covers the hook layer, the smoke renders cover crashes, the pure modules cover the
  logic. Revisit when a screen grows event-driven state.
- **We accept `dangerouslySetInnerHTML` plus regex post-processing of the HTML** (as rm-wenku did)
  in exchange for not shipping a DOM parser; the input is round 1's sanitised output and the passes
  only add `id`/`alt`/`href` values that are themselves escaped.
- **We accept a second Vite config file** (`web/vite.config.ts`) and a second tsconfig in exchange
  for `vp pack` and `vp build` never sharing a `root`; two tools, two files, no interaction to reason
  about. The price is confirming `vp check` covers both programs.
- **We accept the search box changing behaviour** from the old product (ranked results instead of a
  filtered feed) in exchange for using what round 1 built; the filtered feed stays one click away.
- **We accept a theme toggle that herkules.dev does not have** (system default, manual override) in
  exchange for users who prefer light finding it in one click; the tokens stay services/web's.
- **We accept a build-time `PUBLIC_ORIGIN`** for the MCP guide text rather than an API round trip; the
  value changes with the deployment, not the session.
- **We accept `keepPreviousData` on filtered lists**, which shows stale rows for the duration of a
  fetch, in exchange for chips that never flash an empty page.

## Alternatives considered

- **File-based routes + `routeTree.gen.ts`** (A as sketched). Typed routes either way; the generated
  file is a second source of truth and a plugin in the build. Code-based loses nothing here at ten
  routes.
- **Screens own their data with `useQuery` and inline triage** (B). Eight copies of one policy and
  the URL parsed in two places; rejected on depth.
- **`Screen<S, D>` objects with a `view()` view-model** (the review's shape). Deeper `Component`s,
  but a layer that is a pass-through for four of ten screens and a second consumer of the DTO shapes.
- **Keep rm-wenku's stylesheets wholesale** (palette, toggle, fonts). Cheapest port, but bbs would not
  read as herkules'; layout is what was proven, palette is not.
- **A DOM test harness now** (happy-dom + Testing Library). Nothing in v1's screens justifies it;
  `renderToString` smoke tests buy most of the crash coverage for nothing.
- **Serving the SPA from Caddy like services/web.** Impossible with head injection (round 1).

## Contract status against round 1 (`a022dc6`)

Already provided by the server, nothing to request: typed RPC inputs via `@hono/zod-validator`
(`tests/rpc.test.ts`); `Wire<T>` keeps literal unions; `SearchHit.snippet` is `SnippetSegment[] | null`;
`/api/viewer` returns `{ viewer: Viewer | null }`; `LoginFailureCode` is exported from
`@herkules/oauth-client`. Nothing is missing from the DTOs: every field the screens render exists on
`ArticleSummaryDTO`, `ArticleDTO`, `ArticleAiDTO`, `KbBrowseDTO`, `EntityDetailDTO`, `TagIndexDTO`,
`LibraryStatusDTO`, `ViewerDTO`. What remains is entirely on this side: the `tsconfig.json` exclude,
the `vite.config.ts` test include, and the `package.json` dependencies and scripts (diffs above).

## Open questions and risks

1. ~~Search product~~ — **decided 2026-08-28**: the search box goes to ranked `/search`; the
   date-ordered filter stays one click away.
2. ~~Look~~ — **decided 2026-08-28**: services/web tokens, system dark mode by default, **plus a
   manual toggle** (light may be more familiar to users).
3. Risk: does `vp check` type-check the `web/` program (its own tsconfig, no `references`)? If not,
   the compile-time contract is only enforced by whoever runs `tsc -p web`. Decide at the split:
   `references` in the package tsconfig, or a `check:web` script wired into `ready`.
4. Risk: the installed `@tanstack/react-query` / `react-router` versions must have
   `ensureInfiniteQueryData` and the `scrollRestoration` router option; the fallback for the latter is
   the `<ScrollRestoration/>` component.

## Next implementation step

Apply the tsconfig split and `web/vite.config.ts`, add the dependencies, then write `url.ts`,
`api/client.ts`, `api/queries.ts` and `tests/contract.test.ts` against the real app — the contract
test green before any screen exists.

---

## Sketch

Types and signatures; bodies `not implemented`. Paths are the module map's.

### `web/src/url.ts`

```ts
import { z } from "zod";

export const scope = z.enum(["all", "title", "kb"]).default("all");

/** The filter vocabulary `/`, `/search` and `/kb`'s `q` share. Plain object: both route schemas extend it. */
const filter = z.object({
  q: z.string().trim().max(200).optional(),
  scope,
  tag: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
});

/** `group` defaults to `groupOf(tag)` when only `tag` is present — in one place. */
const withGroup = <T extends { tag?: string; group?: string }>(s: T): T => ({
  ...s,
  group: s.group ?? (s.tag ? groupOf(s.tag) : undefined),
});

/** `/` — every field optional. */
export const feedSearch = filter.transform(withGroup);
export type FeedSearch = z.output<typeof feedSearch>;

/** `/search` — `q` optional at the type level; the route's `beforeLoad` redirects a blank one to `/`. */
export const rankedSearch = filter.transform(withGroup);
export type RankedSearch = z.output<typeof rankedSearch>;

export const kbSearch = z.object({
  q: z.string().trim().max(200).optional(),
  domain: z.string().max(64).optional(),
  robot: z.string().max(64).optional(),
  genre: z.string().max(64).optional(),
});
export type KbSearch = z.output<typeof kbSearch>;

export const accountSearch = z.object({ login_error: z.string().max(64).optional() });
export type AccountSearch = z.output<typeof accountSearch>;

/** `硬件/机器人硬件` -> `硬件`; a tag without `/` is its own group. Mirrors `article_tags.group_name`. */
export function groupOf(tag: string): string {
  void tag;
  throw new Error("not implemented");
}
```

### `web/src/api/client.ts`

```ts
import type { InferRequestType } from "hono/client";
import { hc } from "hono/client";

import type {
  ArticleAiDTO,
  ArticleDTO,
  ArticlePageDTO,
  EntityDetailDTO,
  ErrorDTO,
  KbBrowseDTO,
  LibraryStatusDTO,
  SearchPageDTO,
  TagIndexDTO,
  ViewerDTO,
} from "../../../src/api/dto.ts";
import type { AppType } from "../../../src/api/routes.ts"; // type-only: the whole contract

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description: string,
  ) {
    super(description);
    this.name = "ApiError";
  }
}

type Client = ReturnType<typeof hc<AppType>>;
/** Real input types: round 1's `zValidator("query", …)` is what makes `hc` see them (a typo'd key is a compile error). */
export type FeedQuery = InferRequestType<Client["api"]["articles"]["$get"]>["query"];
export type SearchQuery = InferRequestType<Client["api"]["search"]["$get"]>["query"];
export type KbBrowseQuery = InferRequestType<Client["api"]["kb"]["browse"]["$get"]>["query"];

/**
 * One method per route the SPA uses (`/api/kb/entities` has no SPA consumer; `/api/me` is not
 * called — `viewer` answers the same question without a 401). `null` is returned ONLY where a
 * missing id is data: article, ai, entity.
 */
export interface BbsApi {
  articles(query: FeedQuery): Promise<ArticlePageDTO>;
  search(query: SearchQuery): Promise<SearchPageDTO>;
  article(id: string): Promise<ArticleDTO | null>;
  ai(id: string): Promise<ArticleAiDTO | null>;
  tags(): Promise<TagIndexDTO>;
  kbBrowse(query: KbBrowseQuery): Promise<KbBrowseDTO>;
  entity(name: string): Promise<EntityDetailDTO | null>;
  status(): Promise<LibraryStatusDTO>;
  /** `{ viewer: null }` for nobody — never a 401. */
  viewer(): Promise<{ viewer: ViewerDTO | null }>;
}

export interface ApiOptions {
  readonly origin: string;
  /** Injectable so the contract test drives the in-process Hono app (`fetchVia(app)`). */
  readonly fetch?: typeof globalThis.fetch;
}

export function createApi(options: ApiOptions): BbsApi {
  void options;
  // TODO client = hc<AppType>(origin, { fetch, init: { credentials: "same-origin" } })
  //      unwrap(res, nullOn404): res.ok ? res.json() : (res.status === 404 && nullOn404) ? null : throw new ApiError(status, error, error_description) from ErrorDTO
  throw new Error("not implemented");
}
export type { ErrorDTO };
```

### `web/src/api/queries.ts`

```ts
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import type { FeedSearch, KbSearch, RankedSearch } from "../url.ts";
import type { BbsApi } from "./client.ts";

const MIN = 60_000;

/** THE query-key factory. Keys are `["bbs", kind, ...args]`; nobody else writes a queryKey. Lives in the router context. */
export function createQueries(api: BbsApi) {
  return {
    feed: (s: FeedSearch) =>
      infiniteQueryOptions({
        queryKey: ["bbs", "feed", s] as const,
        queryFn: ({ pageParam }) => api.articles({ ...s, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        placeholderData: keepPreviousData, // a tab click re-renders over the previous rows, never an empty page
        staleTime: 10 * MIN,
        gcTime: 15 * MIN, // returning from an article must not collapse the list
      }),
    search: (s: RankedSearch & { q: string }) =>
      infiniteQueryOptions({
        queryKey: ["bbs", "search", s] as const,
        queryFn: ({ pageParam }) => api.search({ ...s, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        staleTime: 10 * MIN,
      }),
    article: (id: string) =>
      queryOptions({
        queryKey: ["bbs", "article", id] as const,
        queryFn: () => api.article(id),
        staleTime: 30 * MIN,
      }),
    ai: (id: string) =>
      queryOptions({
        queryKey: ["bbs", "ai", id] as const,
        queryFn: () => api.ai(id),
        staleTime: 30 * MIN,
      }),
    tags: () =>
      queryOptions({
        queryKey: ["bbs", "tags"] as const,
        queryFn: () => api.tags(),
        staleTime: 5 * MIN,
      }),
    kbBrowse: (s: KbSearch) =>
      queryOptions({
        queryKey: ["bbs", "kb", s] as const,
        queryFn: () => api.kbBrowse({ ...s, limit: "300" }),
        placeholderData: keepPreviousData, // 300 cards per facet click; never flash empty
        staleTime: 5 * MIN,
      }),
    entity: (name: string) =>
      queryOptions({
        queryKey: ["bbs", "entity", name] as const,
        queryFn: () => api.entity(name),
        staleTime: 5 * MIN,
      }),
    status: () =>
      queryOptions({
        queryKey: ["bbs", "status"] as const,
        queryFn: () => api.status(),
        staleTime: Infinity,
      }),
    viewer: () =>
      queryOptions({
        queryKey: ["bbs", "viewer"] as const,
        queryFn: () => api.viewer(),
        staleTime: 30_000,
        refetchOnWindowFocus: true, // a sign-in in another tab shows up
      }),
  };
}
export type Queries = ReturnType<typeof createQueries>;
```

### `web/src/routes.tsx`

```tsx
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";

import type { Queries } from "./api/queries.ts";
import { App } from "./shell/App.tsx";
import { NotFound } from "./shell/NotFound.tsx";
import { RouteError } from "./shell/RouteError.tsx";
import { FeedSkeleton, ReaderSkeleton } from "./shell/Skeletons.tsx";
import { accountSearch, feedSearch, kbSearch, rankedSearch } from "./url.ts";

/** What every loader and screen can reach without importing a singleton. */
export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly q: Queries;
}

/** The shell. `errorComponent` is deliberately NOT here: a screen's failure must not replace the header. */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: App,
  notFoundComponent: NotFound,
});

/** Every child route: parent + per-route error boundary applied once. The options type is TanStack's own. */
const screen = <O extends Parameters<typeof createRoute>[0]>(options: Omit<O, "getParentRoute">) =>
  createRoute({ getParentRoute: () => rootRoute, errorComponent: RouteError, ...options } as O);

export const feedRoute = screen({
  path: "/",
  validateSearch: feedSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(q.tags()),
      queryClient.ensureInfiniteQueryData(q.feed(deps)),
    ]),
  pendingComponent: FeedSkeleton,
  component: () => {
    throw new Error("not implemented: lazy(() => import('./feed/FeedPage.tsx'))");
  },
});

export const searchRoute = screen({
  path: "/search",
  validateSearch: rankedSearch,
  /** A bare or blank search is the feed with the same filters, not an error page. */
  beforeLoad: ({ search }) => {
    if (!search.q) throw redirect({ to: "/", search });
  },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) =>
    queryClient.ensureInfiniteQueryData(q.search({ ...deps, q: deps.q ?? "" })), // q is non-blank past beforeLoad
  pendingComponent: FeedSkeleton,
  component: () => {
    throw new Error("not implemented");
  },
});

export const articleRoute = screen({
  path: "/articles/$id",
  loader: ({ context: { queryClient, q }, params, cause }) => {
    if (cause !== "preload") void queryClient.prefetchQuery(q.ai(params.id)); // hover must not fan out AI reads
    return queryClient.ensureQueryData(q.article(params.id));
  },
  pendingComponent: ReaderSkeleton,
  component: () => {
    throw new Error("not implemented");
  },
});

export const kbRoute = screen({
  path: "/kb",
  validateSearch: kbSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) => queryClient.ensureQueryData(q.kbBrowse(deps)),
  component: () => {
    throw new Error("not implemented");
  },
});
export const entityRoute = screen({
  path: "/kb/$name",
  loader: ({ context: { queryClient, q }, params }) =>
    queryClient.ensureQueryData(q.entity(params.name)),
  component: () => {
    throw new Error("not implemented");
  },
});
export const tagsRoute = screen({
  path: "/tags",
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.tags()),
  component: () => {
    throw new Error("not implemented");
  },
});
export const statusRoute = screen({
  path: "/status",
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.status()),
  component: () => {
    throw new Error("not implemented");
  },
});
export const aboutRoute = screen({
  path: "/about",
  component: () => {
    throw new Error("not implemented");
  },
});
export const accountRoute = screen({
  path: "/account",
  validateSearch: accountSearch,
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.viewer()),
  component: () => {
    throw new Error("not implemented");
  },
});

export const routeTree = rootRoute.addChildren([
  feedRoute,
  searchRoute,
  articleRoute,
  kbRoute,
  entityRoute,
  tagsRoute,
  statusRoute,
  aboutRoute,
  accountRoute,
]);

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0, // React Query owns freshness; the router never caches loader data itself
    defaultPendingMs: 300, // skeletons only for loads that are actually slow…
    defaultPendingMinMs: 300, // …and never for a single frame
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
```

### `web/src/main.tsx` and `web/src/env.d.ts`

```tsx
// main.tsx — runs at module top level (index.html loads it as the entry; nothing else calls it).
// const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
// const q = createQueries(createApi({ origin: location.origin }));
// const router = createAppRouter({ queryClient, q });
// createRoot(document.getElementById("root")!).render(
//   <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
// );

// env.d.ts — the vite `define` constant, so the MCP guide's origin type-checks.
declare const __PUBLIC_ORIGIN__: string;
```

### Pure modules

```ts
// web/src/search/snippet.ts — wire segments -> render model. No bracket parsing: the wire is already segments.
import type { SearchPageDTO } from "../../../src/api/dto.ts";
export type Segment = NonNullable<SearchPageDTO["items"][number]["snippet"]>[number]; // { text, hit }
/** Collapses whitespace, trims, and caps at `max` characters while keeping every hit intact. */
export function trimSegments(segments: readonly Segment[], max?: number): readonly Segment[] {
  void segments;
  void max;
  throw new Error("not implemented");
}

// web/src/reader/prose.ts — ported from rm-wenku reader/headings.ts; regex over the trusted, sanitised string
export interface Heading {
  readonly id: string;
  readonly level: 2 | 3;
  readonly text: string;
}
export interface PreparedProse {
  readonly html: string;
  readonly headings: readonly Heading[];
  readonly deck: string | null;
}
export function prepareProse(
  article: Pick<ArticleDTO, "contentHtml" | "bodyText" | "images" | "links">,
): PreparedProse {
  void article;
  // TODO html = contentHtml ?? paragraphs(bodyText); withImageAlts; withLocalLinks (KEEP other attrs; href -> /articles/{id});
  //      extractLeadHeading -> deck; withHeadingIds -> headings
  throw new Error("not implemented");
}
export function withImageAlts(html: string, images: ArticleDTO["images"]): string {
  void html;
  void images;
  throw new Error("not implemented");
}
export function withLocalLinks(html: string, links: ArticleDTO["links"]): string {
  void html;
  void links;
  throw new Error("not implemented");
}
export function extractLeadHeading(html: string): { html: string; deck: string | null } {
  void html;
  throw new Error("not implemented");
}
export function withHeadingIds(html: string): { html: string; headings: readonly Heading[] } {
  void html;
  throw new Error("not implemented");
}

// web/src/kb/model.ts — ported from rm-wenku kb/model.ts; tallies come from the cards, not /api/kb/entities
export const PITFALL_LIMIT = 14;
export function roundRobin<T>(lists: readonly (readonly T[])[], limit: number): readonly T[] {
  void lists;
  void limit;
  throw new Error("not implemented");
}
export function countEntities(
  cards: KbBrowseDTO["cards"],
): readonly { name: string; count: number }[] {
  void cards;
  throw new Error("not implemented");
}
export function splitEntities(tallies: readonly { name: string; count: number }[]): {
  common: readonly { name: string; count: number }[];
  rest: readonly { name: string; count: number }[];
} {
  void tallies;
  throw new Error("not implemented");
}
export interface EntitySections {
  readonly comparison: readonly {
    articleId: string;
    title: string;
    name: string;
    value: string;
    unit: string | null;
    context: string | null;
  }[];
  readonly otherParameters: readonly {
    articleId: string;
    title: string;
    name: string;
    value: string;
    unit: string | null;
  }[];
  readonly asComponent: readonly {
    articleId: string;
    title: string;
    role: string | null;
    spec: string | null;
  }[];
  readonly decisions: readonly {
    articleId: string;
    title: string;
    decision: string;
    rationale: string | null;
  }[];
  readonly pitfalls: readonly { articleId: string; title: string; pitfall: string }[];
}
export function entitySections(key: string, articles: EntityDetailDTO["articles"]): EntitySections {
  void key;
  void articles;
  throw new Error("not implemented");
}

// web/src/lib/format.ts — Asia/Shanghai everywhere, as rm-wenku
export function formatDate(iso: string | null): string {
  void iso;
  throw new Error("not implemented");
}
export function formatCount(n: number, unit: "字" | "链接" | "图"): string {
  void n;
  void unit;
  throw new Error("not implemented");
}
export function linkKindText(kind: ArticleDTO["links"][number]["kind"]): string {
  void kind;
  throw new Error("not implemented");
} // exhaustive: 仓库/文档/下载/视频/网盘/链接

// web/src/lib/ai.ts
export function maturityClass(status: string): string {
  void status;
  throw new Error("not implemented");
} // the model's free-text status, not a union
export function sectionLabels(genre: string): {
  package: string | null;
  keyPoints: string;
  caveats: string;
} {
  void genre;
  throw new Error("not implemented");
}
export function hasContent(kb: ArticleAiDTO["kb"]): boolean {
  void kb;
  throw new Error("not implemented");
}

// web/src/lib/title.ts
export function cleanExcerpt(excerpt: string | null): string | null {
  void excerpt;
  throw new Error("not implemented");
} // strips a leading 简介：

// web/src/account/loginError.ts — the union is OPEN (`string & {}`): known codes get a line, the rest a default
import type { LoginFailureCode } from "@herkules/oauth-client";
export const LOGIN_ERROR_TEXT: Partial<Record<LoginFailureCode, string>> = {
  invalid_state: "登录已过期，请重试。",
  invalid_request: "登录请求无效。",
  invalid_grant: "登录未被接受，请重试。",
  client_auth: "站点配置错误（客户端凭据）。",
  unavailable: "登录服务暂时不可用。",
};
export const LOGIN_ERROR_DEFAULT = "登录失败。";
/** `undefined` when there is no error; the default line for an unknown (issuer-side) code. */
export function loginErrorText(code: string | undefined): string | undefined {
  void code;
  throw new Error("not implemented");
}
```

### Components (signatures only)

```tsx
// shell
export function App(): JSX.Element; // header + nav + <Outlet/> + footer; never touches document.title
export function AccountChip(): JSX.Element | null; // null until q.viewer settles; login anchor / logout form
export function RouteError({ error }: { error: unknown }): JSX.Element;
export function NotFound({ what }: { what?: "article" | "entity" | "page" }): JSX.Element;
export function FeedSkeleton(): JSX.Element;
export function ReaderSkeleton(): JSX.Element;
export function usePageTitle(title: string | null): void; // document.title = title ? `${title} · RM 文库` : "RM 文库"; called by screens

// feed
export function FeedPage(): JSX.Element; // search: feedRoute.useSearch(); q: feedRoute.useRouteContext(); useSuspenseQuery(q.tags()), useSuspenseInfiniteQuery(q.feed(search))
export function SearchBar({
  value,
  scope,
  to,
}: {
  value: string;
  scope: FeedSearch["scope"];
  to: "/search" | "/";
}): JSX.Element; // submits via navigate({ to, search })
export function CategoryTabs({
  tags,
  search,
}: {
  tags: TagIndexDTO;
  search: FeedSearch;
}): JSX.Element;
export function ArticleRow({
  article,
  snippet,
}: {
  article: ArticleSummaryDTO;
  snippet?: readonly Segment[];
}): JSX.Element;
export function LoadMore({
  hasNext,
  isFetching,
  onMore,
}: {
  hasNext: boolean;
  isFetching: boolean;
  onMore: () => void;
}): JSX.Element; // IO sentinel (rootMargin 800px) + button fallback

// search
export function SearchPage(): JSX.Element; // terms chips, rows with <Snippet/>, "按发布时间排列" -> feed with same filters
export function Snippet({ segments }: { segments: readonly Segment[] }): JSX.Element; // <mark> for hits

// reader
export function ArticlePage(): JSX.Element;
export function Prose({
  html,
  onNavigate,
}: {
  html: string;
  onNavigate: (path: string) => void;
}): JSX.Element; // delegated clicks: internal <a> -> router; <img> -> lightbox
export function Toc({
  headings,
  activeId,
}: {
  headings: readonly Heading[];
  activeId: string | null;
}): JSX.Element;
export function ReaderSidebar({
  sections,
}: {
  sections: readonly { id: "toc" | "ai" | "kb" | "resources"; label: string; node: ReactNode }[];
}): JSX.Element; // sheet ≤ 960px
export function AiOverview({ ai }: { ai: ArticleAiDTO }): JSX.Element; // switch (ai.status): pending -> 尚未生成 (no polling); failed -> error; ready -> sections. Exhaustive.
export function KbPanel({ kb }: { kb: NonNullable<ArticleAiDTO["kb"]> }): JSX.Element;
export function Resources({
  links,
  images,
}: {
  links: ArticleDTO["links"];
  images: ArticleDTO["images"];
}): JSX.Element;
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt: string;
  onClose: () => void;
}): JSX.Element; // native <dialog>

// kb / tags / status / about / account
export function KbPage(): JSX.Element;
export function EntityPage(): JSX.Element;
export function TagsPage(): JSX.Element;
export function StatusPage(): JSX.Element;
export function AboutPage(): JSX.Element;
export function AccountPage(): JSX.Element; // role branch exhaustive over "admin" | "member"
```

### `web/tests/contract.test.ts` and `web/tests/render.test.ts` (shape)

```ts
// contract.test.ts — the hook layer without React
import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createTestBbs, fetchVia } from "../../tests/helpers.ts";
import { createApi } from "../src/api/client.ts";
import { createQueries } from "../src/api/queries.ts";

// bbs = await createTestBbs({ importFixture: true }); q = createQueries(createApi({ origin: "http://bbs.test", fetch: fetchVia(bbs.app) })); qc = new QueryClient()
// it("article 404 is null, not an error");            it("feed pages by cursor until nextCursor is null");
// it("viewer is null anonymous and a Viewer after signIn");   it("kbBrowse facets never contain their own filter");
// it("entity by display name and by key agree");      it("search echoes folded terms and returns segment snippets");

// render.test.ts — react-dom/server smoke renders, node environment, no DOM library
// renderToString(<ArticleRow article={FIXTURE.summary} />) contains the topic; <AiOverview ai={pending|failed|ready}/> renders each branch;
// <KbPanel kb={…}/> renders only when hasContent; <Snippet segments={…}/> emits one <mark> per hit.
```

---

## As built (round 2, 2026-08-28)

Implemented after the checkpoint (ranked search; services/web tokens; system dark mode **plus** the
three-state toggle). Every deviation from the sketch above, with the reason:

- **`screen()` helper dropped.** `Parameters<typeof createRoute>[0]` plus the cast erased the
  path/search generics, collapsing `Link`/`useSearch` typing. Each route is an explicit `createRoute({
getParentRoute, errorComponent, … })` with the two shared values as module consts; a probe confirmed
  `<Link to="/kbb">` and `search={{ scope: "bogus" }}` are compile errors.
- **`groupOf` mirrors the generated column**: `article_tags.group_name` is `split_part(tag, '/', 1)`,
  so everything before the _first_ slash.
- **`limit` is a string on the wire** (`InferRequestType` says `string | string[]`); `q.kbBrowse`
  sends `"300"`, the lists send none.
- `ApiError` uses declared fields, not constructor parameter properties (`erasableSyntaxOnly`);
  `notFoundComponent: () => <NotFound />` because a weak-typed props component is rejected as-is.
- One server edit for the web tsconfig's `noUnusedParameters`: `src/db/search/snippet.ts` `(_, i)`.
- **Pure modules**: `sectionLabels` also returns `appliesWhen` (rm-wenku's overrides differ mostly
  there); `formatDate(null)` → `"—"` (`NO_DATE`) and `formatCount(0, …)` → `""` so callers drop the
  segment; `roundRobin` is generic over lists, the KB page pairs card+text; `normalizeEntity` exported
  for chip↔key matching; the theme boot script is compiled with `node:vm` in its test (`new Function`
  trips `no-implied-eval`).
- **Test files are `.ts` with `createElement`**: `test.include` is `web/tests/**/*.test.ts`.
- **Styling**: one cascade, several source sheets (`styles.css` tokens/primitives/shell, then
  `feed.css`, `search.css`, `reader.css`, `kb.css`, `status.css`, `tags.css`, `account.css`, each
  imported by its page module; Vite emits one file). `.pill.{ok,info,warn}` (from `maturityClass`) are
  shared primitives in `styles.css` since the reader's AI card and the KB cards both render them.
  `index-html.test.ts` pins the boot script whitespace-insensitively because oxfmt reindents inline
  scripts.
- **Feed rows are `<article>`s, not a wrapping `<Link>`** — headline and tag chips are both links.
  Excerpt precedence `tldr ?? excerpt ?? introduction`. The scope switch is `ScopeLinks`, separate from
  `SearchBar` (whose `to` is the submit target). `<Link search>` updater callbacks must stay
  unannotated (`ParamsReducerFn`).
- **Reader**: `Prose` takes `onImage` (the lightbox state lives in the page); the scroll-spy is
  `useActiveHeading()` beside a pure `Toc`; `KbPanelBody` is the router-free half; `Resources` lists
  images as captions rather than a thumbnail grid (it pushed the sheet's content off-screen ≤ 960 px);
  the 内容 section is gated on `sectionLabels().package !== null`; `ready` with a null overview renders
  尚未生成.
- **KB**: section order 参数对比 → 其他参数 → 作为组件 → 相关取舍 → 相关踩坑 → articles; cards use
  raw `title` (no `titleParts` on `KbCard`); 作为组件 rows carry `role`/`spec` only.
- **Shell**: `StatusTiles` and `McpGuide` are split out because importing any page pulls
  `routes.tsx` and therefore every screen; `MCP_URL` has one definition. Status tile 3 shows
  `crawler.lastCheckedAt` + backfill; the import stamp is a full Shanghai datetime.
- **Pack config**: `external` now matches `/^@electric-sql\/pglite/` (the exact string let
  `contrib/pg_trgm` be bundled and its tarball lookup broke a PGlite boot of `dist/main.mjs`), and
  `clean: false` so a bare `vp pack` cannot delete `dist/client`.
- **Independent review** (a second model over the whole tree, with SSR renders of every route through
  the real router against the built server on the real corpus — no crashes, no empty renders): fixed
  `usePageTitle(article.title)` (the server injects `title`, not `topic`; the sketch was wrong), the
  blank-`/search` redirect dropping `q`, seven `--accent-ink` link colours in the reader (invisible in
  light mode), `.page.reader` / `.kb-page` widths (`.page` sets `width`, so a `max-width` above 64rem
  was a no-op), and the feed's double `aria-current` (`Link` stamps `page` last and partial matching
  made 全部 + the tab both active → `activeOptions={{ exact: true }}` and `[aria-current]` selectors).
  From its judgement list, adopted: a search middleware (`url.ts` `stripDerived`) so hrefs never show
  `scope=all` or a `group` equal to `groupOf(tag)`; the search box keeps `tag`/`group` on submit; an
  "AI 概览加载失败" line when the AI read errors; the closed bottom sheet is `inert` ≤ 960 px
  (`matchMedia`); a visible lightbox close button; `leafOf` in `url.ts` replacing three copies. Left as
  is: `formatCount` spacing (inherited), scope switch on a query-less `/` changing only the URL (server
  contract), `useTheme` reading storage in the state initializer (guarded, SSR-safe).
- **Coverage**: 30 files / 217 tests (119 server + 96 web). Router-bearing components
  (`FeedPage`, `SearchPage`, `ArticlePage`, `KbPage`, `EntityPage`, `App`, `AccountChip`, `NotFound`,
  `RouteError`) have no smoke render; the contract test covers every `q.*` against the real app.
- **Proven end to end**: `vp run build` → `dist/main.mjs` + `dist/client/`; the built server on the
  real corpus (PGlite) serves `/` with the boot script and hashed assets, injects the real
  `<title>`/`og:title`/canonical/description for `/articles/:id`, 404s an unknown id, and answers
  `/api/search?q=步兵`.
