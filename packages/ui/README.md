# @herkules/ui

The one cascade for herkules.dev (`services/web`) and bbs.herkules.dev
(`apps/bbs/web`). Decision record: `docs/FRAME-ui.md`.

- `src/theme.css` — `@import "tailwindcss"` (preflight included) plus
  `tw-animate-css`; the design tokens (`--paper`, `--ink`, `--accent`, …) as
  runtime variables with the two-way dark switch (`prefers-color-scheme`
  unless `data-theme` says otherwise), mapped onto Tailwind's namespace and
  onto shadcn's names (`bg-background`, `text-muted-foreground`, …); the
  element defaults both apps share in `@layer base`; and the typographic roles
  every screen repeats (`page`, `page-title`, `eyebrow`, `meta`, `lede`,
  `label`, `tag`) as named utilities.
- `src/components/*.tsx` — shadcn output (Radix, `new-york`). Added with the
  CLI from this directory, never hand-copied:
  `vp dlx shadcn@latest add <name>`.
- `src/lib/utils.ts` — `cn()`.

Consumed as source: an app imports `@herkules/ui/theme.css` once (from its
entry module or its own stylesheet) and runs `@tailwindcss/vite` in its Vite
config. Nothing is built here; `vp check` is the only script.
