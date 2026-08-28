# Frame: shared UI layer — 2026-08-29

## Problem

herkules ships two React SPAs — `services/web` (herkules.dev: login, consent,
settings, admin) and `apps/bbs/web` (bbs.herkules.dev: feed, reader, KB) — that
are meant to read as one product but share no code. The ~50-line token block
is copied verbatim and already drifting (bbs has the `data-theme` toggle, web
does not; bbs has `.btn-primary`, web does not). About ten primitives (`.btn
.card .notice .badge .input .select .empty .eyebrow .lede .skel-*`) are written
twice. Every `services/web` page hand-rolls the same `useState` /
`useEffect` / `try-catch` load-and-act loop (8–16 hooks per page). Adding a
screen to either app means re-deciding things the other app already decided.

## Prior art

- `~/dev/projects/games/chesseval/web` — Tailwind v4 via `@tailwindcss/vite`
  on the same Vite 8 toolchain, own thin `Panel/Stat/DataTable` components, no
  shadcn. Confirms Tailwind v4 works under Vite+; its components are
  chart-specific and are not ported.
- `~/dev/RM/Software/herkules-tools` — Tailwind v3 + shadcn (`button.tsx` only)
  - six Radix packages + cva/clsx/tailwind-merge/lucide. Prior familiarity with
    the shadcn idiom; nothing reusable (v3, different tokens). Not ported.
- `herkules-old`, `rm-wenku` — plain CSS, no library. Nothing to port.
- Ecosystem: shadcn targets Tailwind v4 + React 19 with a Radix or Base UI
  primitive layer and supports a monorepo `packages/ui` target. TanStack Query
  is already in the pnpm catalog and in bbs.

## Decision

**B — one workspace package `@herkules/ui` on Tailwind v4 + shadcn (Radix),
adopted in stages, pixel-neutral.** Plus TanStack Query in `services/web`.

- `packages/ui` exports source (like `packages/utils`): `src/theme.css` (the
  existing tokens as a Tailwind `@theme` block, the guarded two-way dark
  blocks, `@custom-variant dark` keyed on `data-theme`), `src/components/*`
  (shadcn output), `src/lib/cn.ts`. Both apps import `@herkules/ui/theme.css`
  and drop their own token blocks.
- shadcn components are installed by the user running the CLI interactively
  (`shadcn init` / `shadcn add …` targeted at `packages/ui`), not by hand-copied
  sources. Claude restyles the output to the current palette; the user owns
  `components.json`.
- Primitives in v1: button, input, textarea, select, label, badge, alert
  (= `Notice`), table, skeleton, dialog (bbs lightbox), sheet (bbs reader
  sheet), tooltip (bbs dock), avatar. Each replaces its hand-written twin in
  both apps in the same commit.
- Area sheets (`feed.css`, `kb.css`, `reader.css`, `.prose`) stay as CSS.
  They convert to utilities only when that screen is next edited for another
  reason. This frame does not touch them.
- `services/web` pages move to `useQuery` / `useMutation`; `session.tsx`
  becomes a query. react-router stays.
- **TanStack Router unification is evaluated, not decided.** After Query lands,
  a time-boxed (≤ half a day) prototype ports `services/web` routing on a
  branch; it is adopted only if the session guards (`Navigate` to `/login`
  with `next`, admin refusal) and every test port without new abstractions.
  Otherwise the branch is deleted and the reason recorded here.

Alternatives considered:

- **A — `packages/ui` with plain CSS.** Kills the copy with zero new
  dependencies, but leaves dialog/sheet/select/tooltip accessibility
  hand-rolled, which is where the next duplication would appear. Lost on that.
- **C — Tailwind v4 only, own primitives (the chesseval pattern).** Same
  accessibility gap as A with the class-string cost of B. Lost.
- **Adopting shadcn's default look.** Throws away the tokens work and changes
  two live sites' appearance for no product reason. Rejected; shadcn is
  restyled to herkules, not the reverse.
- **Base UI as primitive layer.** Fewer packages, but no prior art in the
  user's repos and a smaller community catalogue. Radix chosen.

## In scope

- `packages/ui` with theme, `cn`, and the v1 primitive list above.
- Both apps consuming the theme; both token blocks deleted.
- Each v1 primitive replacing its hand-written equivalent in both apps.
- `services/web`: TanStack Query for every page load and action.
- `services/web`: the TanStack Router evaluation (branch + a recorded verdict).
- Tests kept green; screenshot comparison before/after for each replaced screen.

## Out of scope

- Rewriting `feed.css`, `kb.css`, `reader.css`, `account.css`, `.prose`
  into utilities.
- Any visual redesign, new colours, new type, motion, or fonts.
- Icon library (lucide) — no icons are used today; not added speculatively.
- New screens or features in either app.
- Form libraries (react-hook-form, zod-resolver) — the forms are one field each.
- Storybook or a component gallery.
- Touching `services/auth`, `apps/bbs/src` (Hono/MCP), or deploy.

## Kill criterion

- If matching the current look requires forking (editing the internals of)
  more than **three** shadcn components, the library is fighting the design:
  stop, and fall back to A for the primitives that don't fit.
- If `@tailwindcss/vite` does not run under Vite+ 0.3 / Rolldown for both apps
  in `vp dev` and `vp build` within the first session, stop and re-frame
  (chesseval suggests it will, but on a different Vite+ version).
- If the Router prototype needs a new abstraction to reproduce the session
  guards, the unification is not free: delete the branch, record it, keep
  react-router.

## Done predicate

- `grep -rn -- '--paper:' services/web/src apps/bbs/web/src` returns nothing;
  the only definition is in `packages/ui/src/theme.css`.
- `grep -rn 'useEffect' services/web/src/pages` returns nothing.
- Every class in the v1 primitive list (`.btn .notice .badge .input .select
.textarea .field .table-wrap .skel .skel-line .chip`) is gone from both
  apps' CSS.
- `vp run ready` passes (build, check, test for every package).
- Before/after screenshots of `/`, `/settings`, `/admin`, bbs `/`, an
  article, and a KB page show no unintended difference in light and dark.
- `docs/FRAME-ui.md` carries the TanStack Router verdict, either way.
