# services/web — design

The SPA at `https://herkules.dev/`: login, consent, settings, admin and the
dev-token page. Static files served by Caddy; every call goes to `services/auth`
under `/auth` on the same origin with the session cookie. No state of its own,
no build-time configuration: the origin it runs on is the origin it calls.

## Usage (the person's view)

```
/login              Continue with GitHub. With ?client_id=…&sig=… (an IDE mid-authorization) it
                    names the client and continues the OAuth flow after sign-in.
                    Refusals arrive as ?error=…&error_description=… and are shown in the service's words.
/consent?<signed>   The grant as a ledger line:  <client>  →  <resource title>.  Allow / Deny.
/                   You (name, login, role) and every connected client with Disconnect.
/dev-token          Pick an audience → real PKCE run against `herkules-web` → /dev-token/callback
                    shows the 15-minute JWT, its claims, Copy token / Copy curl.
/admin              Members: Make admin / Make member, Sign out everywhere, Disable (reason) / Enable.
/admin/allowlist    Add a GitHub login (+ note), Remove.
/admin/audit        One sentence per row, newest first, filter by type, Show older (keyset cursor).
```

## Shape

| module            | owns                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api.ts`      | Typed client for Better Auth routes and `/auth/api/*`; every non-2xx → `ApiError(status, code, description)` from the service's own JSON            |
| `src/devtoken.ts` | PKCE pair, authorize URL, one-shot callback exchange keyed by `state` in sessionStorage; `decodeJwtPayload` for display. Framework-free, tested     |
| `src/format.ts`   | Audit event → sentence (names resolved by the page), gate reasons → words, resource URL → name, dates                                               |
| `src/session.tsx` | `SessionProvider` (one `get-session` per load), `RequireAuth` (→ `/login?next=`), `RequireAdmin`, `safeNext`                                        |
| `src/pages/*`     | One file per route above; pages hold only UI state and call `api`                                                                                   |
| `src/main.tsx`    | Router: `/login` and `/consent` outside the shell; everything else inside `RequireAuth` + top bar; `/admin/*` inside `RequireAdmin`                 |
| `src/styles.css`  | Tokens (light/dark), primitives, page layouts. Flat single-class selectors                                                                          |
| `vite.config.ts`  | Dev server IS the public origin (`:3000`) and proxies `/auth`, `/.well-known`, `/mcp/directory` to the local services — the same paths Caddy routes |

## Decisions

- **Dev origin = `http://localhost:3000` = the SPA dev server.** The auth
  service and the directory run with `PUBLIC_ORIGIN=http://localhost:3000` and
  are reached through the Vite proxy. Cookies, the issuer, PRM URLs and the
  first-party redirect URI all agree without a Caddy on the laptop.
- **Consent trusts nothing from the URL except to display it.** The page
  answers `POST /auth/oauth2/consent` with the signed query Better Auth sent it;
  client name comes from `/auth/oauth2/public-client`, resource titles from
  `/auth/api/registry`. Unsigned visits get "Nothing to approve".
- **Dev token requests `scope=offline_access`** — the only scope the registry
  allows per resource. Omitting `scope` makes Better Auth apply its OIDC
  defaults and mint an array `aud` that also names its own userinfo endpoint.
  A refresh token comes along with it; the auth service refuses to honour it
  for `herkules-web` (`unauthorized_client`), which the flow test proves.
- **Typography from the subject, no font downloads.** Display face is the
  system Palatino/Iowan stack (a classical serif for a server named after
  Hercules), body is system-ui, ids and tokens are mono. Mainland users pay
  nothing for fonts. Colour: slate paper, verdigris accent, one danger red;
  dark scheme via tokens. No motion.
- **Confirmation dialogs are the browser's** (`confirm`/`prompt`) for the
  destructive admin actions. A small team's admin console does not need a
  modal system; the audit log is the real safety net.

## Tests

- `tests/flow.test.ts` — the api client and the dev-token flow against the real
  auth service (`@herkules/auth/testing`, PGlite, fake GitHub): session,
  registry, connected clients + disconnect, PKCE authorize → callback → token
  (single `aud`, ≤ 15 min, replay refused, refresh refused), admin calls refused
  for members and audited for admins.
- `tests/format.test.ts` — audit sentences, id collection, gate reasons, dates.

Not covered: rendering. Pages are thin over `api`; the kill-criterion run with
real Claude Code / VS Code exercises login and consent in a real browser.
