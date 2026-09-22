# Training

Public course framework at `https://training.herkules.dev`: VitePress + Vue,
Markdown lessons, a browser-worker PID lab, and an editable Rust Playground demo.
This is a new workspace; it does not move or modify the sibling `herkules-training`.

## Commands

From the monorepo root:

```sh
vp install
vp run @herkules/training#dev       # http://127.0.0.1:3004
vp run @herkules/training#build     # Vue/TS checks + static output in apps/training/dist
vp run @herkules/training#test
vp run ready
```

`vp run dev` also starts training. No env file, backend or database is required.

## Authoring

- Add lessons under `docs/` and navigation in `docs/.vitepress/config.mts`.
- Lesson language is Simplified Chinese with English technical terms.
- Embed `<ClientOnly><PidLab /></ClientOnly>` or `<ClientOnly><RustLab /></ClientOnly>`.
- Register reusable Vue widgets in `docs/.vitepress/theme/index.ts`.
- Everything under `docs/` is public. Keep contributor documentation outside it.
- The site uses root-based clean URLs; never carry over the sibling site's Pages prefix.
- VitePress is pinned to the same alpha as the sibling course project. Validate upgrades
  with Vue type checking, a production build, worker interaction and clean-URL checks.

Vue type checking uses workspace-local TypeScript 5.9 because `vue-tsc` currently
requires the JavaScript compiler API removed by the root TypeScript 7 package.
The root Vite+ lint/type checks remain enabled.

## Current demos

The PID lab uses a deterministic TypeScript reference simulation in a Web Worker:
5 ms fixed integration, 12 s horizon, second-order plant, actuator limits,
conditional-integration anti-windup and a load step. Plotting uses uPlot. Values
are explicitly bounded. The Rust firmware PID crate is not yet imported or
compiled to WASM; this teaching model is not firmware-equivalent.

The Rust editor uses CodeMirror. Clicking its clearly labelled external link sends
source to the official Rust Playground. There is no fake local compile result,
server-side code execution, persistent progress, authentication or grading.
The source is held in memory and resets on page reload.

## Extension boundary

Keep lesson rendering static. A future same-origin `/api/exercises` service should
reuse Herkules OAuth and own submissions, quotas and progress. Suggested contract:

- `POST /api/exercises/:id/submissions` with `{ source, exerciseVersion }` returns
  `202 { id }`; the server selects the toolchain, harness and dependency allowlist.
- `GET /api/submissions/:id` returns queued/compiling/running/completed/failed,
  structured diagnostics, bounded output and test results; authorize ownership.
- Optional WASM artifacts expose a versioned controller ABI for a browser worker.
  Grade separately on the server; client results are not authoritative.

Compilation must run outside the web service in isolated, resource-limited jobs,
including Cargo build scripts and macros. No network, host secrets or arbitrary
user dependency manifests. WASI execution needs explicit resource budgets too.
Do not point this public UI at an unrestricted shell or a Docker socket.

A future Rust/WASM implementation can replace the simulation worker behind its
`{ id, parameters }` → `{ id, result | error }` message contract. First add parity
checks against the fixed-step reference and pin the firmware crate revision.

## Delivery

The existing `platform` image carries `dist/` at `/srv/training` and the route
fragment at `/caddy/training.caddy`. `herkules-infra` owns the hostname, proxied
DNS record and Origin CA verification. It needs no new image key, Compose service,
database or secrets. Training is served by Caddy, not the platform asset Worker.

Publish the application artifact, select its immutable manifest in infrastructure,
then deploy the matching infrastructure change. Older platform artifacts do not
have the required route fragment; Caddy validation intentionally rejects them.
