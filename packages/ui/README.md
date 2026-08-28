# @herkules/ui

The one cascade for herkules.dev (`services/web`) and bbs.herkules.dev
(`apps/bbs/web`): theme, shared primitives, and `cn()`. Decision record:
`docs/FRAME-ui.md`.

## Run and test

Nothing is built here — apps consume `src/` directly.

```sh
vp check
```

## Decisions that bind

- One cascade, both apps: tokens, element defaults, typographic roles, and the
  shadcn primitives live only here. App-local CSS is limited to what the
  cascade cannot reach (bbs keeps `.pill` and `.prose`).
- Tailwind v4 + shadcn (Radix, `new-york`), per `docs/FRAME-ui.md`. Components
  are added with the CLI from this directory, never hand-copied:
  `vp dlx shadcn@latest add <name>`.
- Exported as source and never built: an app imports `@herkules/ui/theme.css`
  once (from its entry module or its own stylesheet) and runs
  `@tailwindcss/vite` in its Vite config. `vp check` is the only script.

## Code map

- `src/theme.css` — `@import "tailwindcss"` (preflight included) plus
  `tw-animate-css`; the design tokens (`--paper`, `--ink`, `--accent`, …) as
  runtime variables with the two-way dark switch (`prefers-color-scheme`
  unless `data-theme` says otherwise), mapped onto Tailwind's namespace and
  onto shadcn's names (`bg-background`, `text-muted-foreground`, …); the
  element defaults both apps share in `@layer base`; and the typographic roles
  every screen repeats (`page`, `page-title`, `eyebrow`, `meta`, `lede`,
  `label`, `tag`) as named utilities.
- `src/components/*.tsx` — shadcn output (Radix, `new-york`).
- `src/lib/utils.ts` — `cn()`.
