# services/auth — design

Status: type sketch (bodies `not implemented`), synthesized 2026-08-28 from three
arena candidates. The `betterAuth({...})` literal in `src/auth.ts` is real code
because that literal is the service. Issuer side of `docs/tokens.md`;
`packages/auth-middleware` is the verifier side.

## Problem

Wrap Better Auth 1.7.2 (`jwt`, `admin`, `mcp`→`oauthProvider`, `cimd`) into one
Hono container at `https://herkules.dev/auth` that: admits GitHub users who are
in the controlled org or on an allowlist, re-checks that on every token grant,
stamps `role` into 15-minute EdDSA access tokens with one audience per registry
resource, serves RFC 9728 metadata for every resource, exposes a user-info API,
and makes every authority change an audit row. Four verified Better Auth facts
make the shape non-obvious (GROUNDING in the sketch dir): the org check needs
the GitHub token, which only the provider's `getUserInfo` holds, while rejection
belongs in `validateUserInfo`; the refresh grant checks nothing (no ban, no
session, no identity) and its callbacks see a `user` but no request; `mcp()`
serves protected-resource metadata for one resource only; the admin plugin's
ban kills sessions but not OAuth refresh tokens. Everything must also fit next
to the services it protects on a 2 vCPU / 4 GB box.

## Usage (caller's view)

**Resource-server author.** You point at three stable URLs — issuer
`https://herkules.dev/auth`, JWKS `…/auth/jwks`, and your PRM document
`https://herkules.dev/.well-known/oauth-protected-resource/mcp/<name>` — all
derived from one line in `src/registry.ts`:

```ts
export const RESOURCE_SPECS: readonly ResourceSpec[] = [
  { name: "directory", kind: "mcp", title: "herkules directory (MCP)", canonical: true },
  { name: "lark", kind: "mcp", title: "Lark (MCP)" }, // <- your line; deploy; done
];
```

To resolve a `sub` into a person, forward the caller's own token (any registry
audience is accepted; the user-info API is not itself a resource):

```ts
const res = await fetch("https://herkules.dev/auth/api/users/batch", {
  method: "POST",
  headers: { authorization: `Bearer ${principal.token}`, "content-type": "application/json" },
  body: JSON.stringify({ ids }),
}); // { users: [{ id, displayName, avatarUrl, githubId }] }
```

**SPA author (`services/web`).** Login page (`/login?<signed query>` or plain):

```ts
const r = await fetch("/auth/sign-in/social", {
  method: "POST",
  headers: json,
  body: JSON.stringify({
    provider: "github",
    callbackURL: "/",
    oauth_query: location.search.slice(1) || undefined,
  }),
});
location.href = (await r.json()).url; // GitHub -> /auth/callback/github -> (consent | client redirect | "/")
// rejections come back as /login?error=not_org_member&error_description=...
```

Consent page (`/consent?<signed query>`): `GET /auth/oauth2/public-client?client_id=…`
for the name, then `POST /auth/oauth2/consent { accept: true, oauth_query }` and
navigate to the returned `redirect_uri`. Better Auth re-prompts on its own when
a known client asks for a resource it has not been granted, so "consent per
client per resource" needs no server switch.

Settings/admin call `/auth/api/*` with the session cookie; every write is one
idempotent PUT/DELETE and one audit row:

```ts
await fetch(`/auth/api/admin/users/${id}/disabled`, {
  method: "PUT",
  headers: json,
  body: JSON.stringify({ disabled: true, reason: "left team" }),
});
// -> { changed: true }: banned, sessions gone, refresh tokens revoked, audit "admin.user_disabled" — one transaction
await fetch(`/auth/api/me/clients/${clientId}`, { method: "DELETE" }); // disconnect an IDE: consent + refresh tokens + audit
```

Dev-token page: `GET /auth/api/registry` lists audiences; the page runs a real
authorization-code + PKCE flow against the first-party public client
`herkules-web` (skipConsent, no refresh grant) and shows the 15-minute JWT.

**Operator.** `.env` validated at boot with every problem listed at once
(`src/config.ts`); migrations at boot under an advisory lock; `ADMIN_GITHUB_LOGINS`
seeds admins at boot and first login and never demotes; `vp test` runs the whole
service on PGlite with a fake GitHub.

### HTTP surface

| Path                                                                                                                                                                                                                   | Method      | Caller                         | Auth                                                       | Served by                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/{mcp,api}/<name>`                                                                                                                                                               | GET, HEAD   | MCP clients                    | none                                                       | us (registry; shadows the plugin's single-resource route)                                                |
| `/.well-known/oauth-authorization-server/auth`, `/auth/.well-known/oauth-authorization-server`, `/auth/.well-known/openid-configuration`                                                                               | GET         | MCP clients                    | none                                                       | Better Auth (plugin `onRequest`, reached via `app.on(["GET","HEAD"], "/.well-known/*")`)                 |
| `/auth/jwks`                                                                                                                                                                                                           | GET         | resource servers               | none                                                       | Better Auth jwt                                                                                          |
| `/auth/oauth2/register`                                                                                                                                                                                                | POST        | Claude Code, VS Code (DCR)     | none; 20/h                                                 | Better Auth + before-hook (`clients.ts` quirks, redirect allowlist)                                      |
| `/auth/oauth2/authorize`                                                                                                                                                                                               | GET, POST   | IDE via browser, SPA dev-token | session (else 302 `/login`)                                | Better Auth                                                                                              |
| `/auth/oauth2/token`                                                                                                                                                                                                   | POST        | IDE, SPA dev-token             | PKCE, public `client_id`                                   | Better Auth + `customTokenResponseFields` (gate) + `customAccessTokenClaims` (role) + after-hook (audit) |
| `/auth/oauth2/consent`, `/auth/oauth2/public-client`                                                                                                                                                                   | POST, GET   | SPA consent page               | session                                                    | Better Auth + after-hook (audit)                                                                         |
| `/auth/oauth2/introspect`, `/revoke`                                                                                                                                                                                   | POST        | (unused by us)                 | client auth                                                | Better Auth                                                                                              |
| `/auth/sign-in/social`, `/auth/callback/github`, `/auth/get-session`, `/auth/sign-out`                                                                                                                                 | POST, GET   | SPA, GitHub                    | none / cookie                                              | Better Auth + gate + after-hook                                                                          |
| `/auth/api/users` (directory), `/auth/api/users/:id`, `/auth/api/users/batch`                                                                                                                                          | GET, POST   | resource servers, SPA          | session **or** JWT for any registry audience; banned → 403 | us                                                                                                       |
| `/auth/api/registry`                                                                                                                                                                                                   | GET         | SPA dev-token                  | session                                                    | us                                                                                                       |
| `/auth/api/me/clients`, `/auth/api/me/clients/:clientId`                                                                                                                                                               | GET, DELETE | SPA settings                   | session                                                    | us                                                                                                       |
| `/auth/api/admin/users` (GET), `/users/:id/role` (PUT), `/users/:id/disabled` (PUT), `/users/:id/sessions` (DELETE), `/users/:id/clients/:clientId` (DELETE), `/allowlist[/:login]` (GET, PUT, DELETE), `/audit` (GET) |             | SPA admin                      | session, role admin                                        | us (audited transactions)                                                                                |
| `/auth/avatars/:userId`                                                                                                                                                                                                | GET         | browsers                       | none                                                       | us (volume cache)                                                                                        |
| `/auth/healthz`                                                                                                                                                                                                        | GET         | compose, Caddy                 | none                                                       | us                                                                                                       |
| `/auth/token`, `/auth/update-user`, `/auth/delete-user`, `/auth/change-email`, `/auth/oauth2/delete-consent`, every `/auth/admin/*`                                                                                    | —           | —                              | —                                                          | **disabled** (`DISABLED_PATHS`, exact names)                                                             |

## Shape

Data first. Four types carry the design:

- `ResourceSpec` → `Registry` (`registry.ts`). Audience, PRM URL (via the
  verifier package's own `resourceMetadataUrlFor`), `oauthResource` row,
  dev-token menu and the user-info audience policy are pure derivations of one
  checked-in line; exactly one `canonical: true` entry, enforced at boot.
- `Evidence` → `decide()` → `Verdict` (`gate.ts`). Pure policy with precedence
  banned > envAdmin > allowlist > org, phases `login` | `grant`, and an explicit
  rule for "GitHub unknown" (fail closed at login; bounded `org-stale` grace at
  grant time). The verdict rides on the GitHub profile as `profile.herkules`
  from `getUserInfo` (has the token; allowlist checked first so allowlisted
  users never depend on GitHub) to `validateUserInfo` (rejects, audits) and
  `mapProfileToUser` (persists `admittedVia`/`gateCheckedAt`). At grant time
  `Gate.recheck` rebuilds the same `Evidence` from the row and the stored
  account token, honouring `GATE_RECHECK_TTL`.
- `AuditEvent` (`audit.ts`), a closed union with one insert path. Plugin
  traffic becomes events through one after-hook whose `AUDITED_PATHS` table is
  exhaustive over `PluginAuditPath`; admin mutations exist only as
  `audited(actor, change)` transactions in `users.ts`, where `change` must return
  the event it justifies; gate rejections go through `Gate.reject`. Every write
  is awaited — a failed audit insert fails the request.
- `Caller` (`bearer.ts`): session or any-registry-audience token, banned users
  refused, `Role` read from row/claim never re-derived. One `identify()` guards
  all of `/auth/api`.

`auth.ts` is the authorization server, written as one options literal with the
two flows traced in its header. Grant re-check sits in
`customTokenResponseFields` (every grant, before any token exists, throw =
clean `invalid_grant`); role stamping in `customAccessTokenClaims` with
`roleOf` throwing on anything but the two literals. Scopes: the AS advertises
the OIDC vocabulary for future first-party OIDC clients, but every registry
resource's `allowedScopes` is `["offline_access"]`, so MCP tokens carry a
single-string `aud`, no id_token, and exactly the scope that yields a refresh
token. "Disable user" is one transaction in `users.ts` (ban, delete sessions,
revoke refresh tokens, audit; idempotent; last-admin guard); Better Auth's
`/admin/*` is closed by name so no second, unaudited door exists. Client quirks
are a pure `QUIRKS` list in `clients.ts` (native-by-default, redirect allowlist)
plus an intentionally empty `STATIC_CLIENTS` escape hatch that doubles as the
kill-criterion probe. Validation lives at three boundaries: `loadConfig`,
`roleOf`/`isStamped`/`gateUserRowOf`, `Bearer.identify`; inside, types are trusted.

Interface depth: the public surface is the HTTP table and seven factories
(`buildRegistry`, `createGate`, `createAudit`, `createUsers`, `createBearer`,
`createAvatars`, `createApp`) wired by `createService`. Behind them sit the
plugin composition, the token-hook dance, the stamp hand-off, the grace policy,
PGlite-vs-Postgres and migration locking. Call chains: `app → users → db`,
`auth → gate → github`, `auth → audit → db`. Three files at most.

## Synthesis decision

Base: **c1** (fable). Cross-judge (opus, independent) and parent agreed: the only
candidate with no contradiction of a grounded fact, the sharpest gate (pure
`decide`, explicit unknown policy), structurally forced audit rows, the only
complete HTTP table including a disabled row, and the only test story that runs
done-predicate 2 without Docker.

Grafted from c2 (opus): per-resource `allowedScopes` filter with the OIDC
vocabulary kept at AS level (c1 amputated `openid` globally, which would have
made the AS useless as the BBS's future OIDC provider); banned users refused at
the user-info API; env admins as a seed that never demotes plus a boot-time
reconcile (c1 re-asserted on every login, undoing UI demotions); exact
`disabledPaths` enumeration (c1 used a glob that the router's exact match would
ignore); `resourceMetadataUrlFor` shared with the verifier package; the
`STATIC_CLIENTS` stub as the kill-criterion probe; `gate.stale_allow` and
`admin.seeded` audit events; `cookieCache` off (it contradicted instant disable).
Grafted from c3 (sonnet): the explicit `canonical: true` flag with a boot-time
throw; client-visible rejection text that never names the org; allowlist checked
before any network call.

Rejected: c2's `localhost`→`127.0.0.1` rewrite (the token request's
`redirect_uri` must match the stored one and the hook did not cover
`/oauth2/token`); c2's forced `prompt=consent` (Better Auth already re-prompts
for a new resource — verified in `authorize.ts`); c2's `Store` interface with a
second in-memory implementation (PGlite runs the one real engine); c2's
`extensions[]` claim contributor for `role` (`customAccessTokenClaims` suffices);
c3's `runInBackground` audit and `/admin/*` prefix audit (lossy, body-sniffing);
c3's in-`mcp()` `disabledPaths` and `input: false` gate fields (both contradict
grounded facts).

## Tradeoffs accepted

- `input: true` on the four gate/GitHub fields (the only way `mapProfileToUser`
  may set them) in exchange for one write path; the exposure is closed by
  disabling `/update-user`.
- Awaited audit writes on the login/token hot path (~1 ms local insert) in
  exchange for a fail-closed audit; `runInBackground` would make "cannot be
  forgotten" a hope.
- A GitHub call per user per `GATE_RECHECK_TTL` (10 min) at grant time and a
  24 h `org-stale` grace on outages, in exchange for "re-checked on every grant"
  being true within the TTL and a GitHub blip not locking the team out of every
  IDE at once; allowlisted users never depend on it, and a disabled user is
  refused before GitHub is consulted.
- `offline_access` in the token's `scope` claim (tokens.md updated) in exchange
  for spec-conformant refresh-token issuance; the middleware ignores it.
- Shadowing the plugin's PRM route for the canonical resource so one code path
  builds every document, with the shape pinned in `ProtectedResourceMetadata`.
- PGlite as a devDependency (~10 MB wasm) in exchange for one engine and no
  second store implementation; Better Auth's own code exchange uses global
  `fetch`, so the test harness patches it for github.com and refuses other hosts.
- A cookie-cache-free session (one DB read per SPA request) in exchange for a
  disable that is immediate on every device.
- No automatic JWKS rotation in v1; verifiers already select by `kid`, so
  enabling it later is a config change.

## Alternatives considered

- Org check in `validateUserInfo` via the stored account token: no token on
  first login; two paths and two GitHub calls per login. Lost.
- Org check in `hooks.after "/callback/github"` (the old repo): the row and
  session already exist, rejection becomes create-then-delete, and failure
  degrades to a guest role. Lost.
- Grant re-check in `hooks.before "/oauth2/token"`: has the request, not the
  user; would duplicate refresh-token lookup and rotation. Lost.
- Let the SPA use Better Auth's `/admin/*` and audit in an after-hook: cannot
  make ban + refresh-revoke atomic, no last-admin guard, lossy audit. Lost.
- Env-driven registry: exposes an audience string (a security boundary) to an
  unreviewed text field. Lost to a checked-in array.
- A `POST /auth/api/dev-token` mint endpoint: a second issuance path no IDE
  exercises and the most attractive endpoint on the box. Lost to a first-party
  PKCE client.
- User-info accepting only its own audience: every resource server would need a
  second token just to read display names. Lost to "any registry audience".

## Implementation notes (Phase D, 2026-08-28)

What implementation taught that the sketch did not know. Each is now pinned by
a test in `tests/`.

- **`mapProfileToUser` is never called when `getUserInfo` is overridden.**
  Better Auth's GitHub provider short-circuits entirely; the additional user
  fields (`githubLogin`, `githubId`, `admittedVia`, `gateCheckedAt`) reach the
  row only as extra keys on the `user` object `getUserInfo` returns (they are
  parsed with `parseAdditionalUserInputFromProviderProfile`, on create and on
  every returning sign-in). `auth.ts` copies the stamp there; the
  `mapProfileToUser` option is gone.
- **`ctx.path` in `hooks.after` is the route pattern**, so the login audit key
  is `/callback/:id`, not `/callback/github`. `AUDITED_PATHS` says so.
- **`/oauth2/consent` returns `{ redirect: true, url }`**, not `{ redirect_uri }`.
- **One consent row per (client, user); its `resources` are overwritten by the
  latest consent**, not unioned. Consequences: "connected clients" shows the
  most recent consent's resources (the audit log has the history), and an IDE
  that alternates between two herkules resources is re-prompted each time it
  switches. Accepted for v1: one IDE client normally targets one MCP server.
- **Better Auth mints a refresh token whenever `offline_access` is granted and
  honours it regardless of the client's `grant_types`.** The dev-token client
  therefore carries `metadata.herkules.devToken = true`, and
  `customTokenResponseFields` (the only token callback that receives client
  metadata) refuses `refresh_token` grants for it with `unauthorized_client`.
- **`advanced.database.generateId: "uuid"` means "the database generates
  ids"** (Better Auth inserts `DEFAULT`), so it was dropped; Better Auth's own
  32-character ids are used. Our own tables keep their own id strategy (audit:
  UUID v7 for keyset paging).
- **The first-party client is a direct row insert**: `adminCreateOAuthClient`
  generates its own `client_id`, and the SPA needs the stable `herkules-web`.
- **A stale allow keeps the OLD `gateCheckedAt`**, so refreshing during a
  GitHub outage cannot extend the `GATE_STALE_MAX` window, and the next grant
  after GitHub returns re-asks immediately.
- Schema: `scripts/generate-schema.ts` renders `getSchema(authOptions(...))`
  into `src/db/schema.auth.ts` (12 tables); `drizzle-kit generate` diffs it
  into `drizzle/*.sql`; `db/index.ts` applies the folder at boot on either host.
- Tests: 47 in `tests/` (gate truth table, registry, quirks, audit extractors,
  a smoke flow and 19 integration scenarios on PGlite with the fake GitHub),
  including the middleware verifying a token the real Better Auth minted and
  refusing it for the other registry audience.

## Open questions and risks

- Do Claude Code and VS Code request `scopes_supported` from the PRM
  (`offline_access`)? If one does not, it gets no refresh token and re-runs the
  browser flow every 15 minutes. Fallback: a before-hook on `/oauth2/authorize`
  injecting `scope=offline_access` — acceptable, or accept the re-login?
- `vscode://` redirects are rejected by Better Auth under both application
  types; VS Code's MCP client currently uses loopback. If not, `STATIC_CLIENTS`
  is the escape hatch and the kill criterion is live. First thing to probe.
- Should the `localhost` port-variance quirk (old repo) ship disabled in
  `QUIRKS`, or wait for a client to need it? Better Auth ignores the port for
  `127.0.0.1`/`[::1]` but not for the name `localhost`.
- 24 h stale grace on GitHub outages vs the 10 min TTL: a user removed from the
  org during an outage keeps refreshing for up to a day. Right window?
- CIMD is open to any https document URL (as is unauthenticated DCR). A CIMD
  client still needs a gated user to consent; set `isMetadataDocumentUrlAllowed`
  to an allowlist of known hosts anyway?
- Does `overrideUserInfoOnSignIn` re-run `mapProfileToUser` for returning users
  (grounding says provider fields are applied on sign-in)? If not, `admittedVia`
  and `gateCheckedAt` move to a `validateUserInfo` write for the `sign-in` action.
- Root `/.well-known/*` forwarding to `auth.handler` relies on plugin `onRequest`
  running before route matching (verified in `api/index.ts`); confirm on first
  boot; fallback is the exported `oauthProviderAuthServerMetadata` handler.
- Audit table: give the service role no UPDATE/DELETE in prod (second Postgres
  role in compose)? Recommendation: yes.

## Next implementation step

Done: every module body, the schema/migration pipeline, and the test suite.
`services/mcp-directory` (2026-08-28) consumes the surface above and added one
route, `GET /auth/api/users` (member directory for any identified member).
`services/web` (2026-08-28) codes against the surface above unchanged.
Next: `tools/deploy`.
