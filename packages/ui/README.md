# @herkules/ui

The one cascade for herkules.dev (`services/web`) and bbs.herkules.dev
(`apps/bbs/web`). Decision record: `docs/FRAME-ui.md`.

- `src/theme.css` — the design tokens (`--paper`, `--ink`, `--accent`, …) as
  runtime variables with the two-way dark switch, mapped onto Tailwind v4's
  namespace and onto shadcn's names. Imports Tailwind's theme and utilities
  layers **only**: no preflight, the apps own their base-element rules.
- `src/components/*.tsx` — shadcn output (Radix, `new-york`), restyled to the
  tokens. Added with the CLI from this directory, never hand-copied:
  `pnpm dlx shadcn@latest add <name>`.
- `src/lib/utils.ts` — `cn()`.

Consumed as source: each app's `styles.css` starts with
`@import "@herkules/ui/theme.css";` and its Vite config runs
`@tailwindcss/vite`. Nothing is built here; `vp check` is the only script.
