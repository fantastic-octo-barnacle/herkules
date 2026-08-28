# `@herkules/oauth-client` — design (2026-08-28; checkpoint approved, implemented)

## Problem

`apps/bbs` (and every first-party app after it) must sign browsers in through
the herkules issuer while serving anonymous reads, member-only writes and
MCP-over-bearer from one Hono app, and the cost of adopting this for app #2
must be a few lines. Four constraints make the shape non-obvious. Handlers may
see exactly one identity type — `Principal` from `@herkules/auth-middleware`,
built only by `ResourceAuth.verifyToken`; a second verifier or a second type is
forbidden. There is no session table (FRAME), so everything a session is must
fit in a sealed cookie. The issuer rotates refresh tokens on every use with a
30-second replay window and family revocation beyond it, so six tabs
presenting one expired cookie is a correctness problem. Anonymous is the normal
case for a public archive, so "optional auth" must not become a second code
path. The issuer side is fixed: exact-match redirect URIs, PKCE forced by
`offline_access`, strict `client_secret_basic`, `openid` filtered away per
resource (no `id_token`), `role` in the access token, the gate re-run on every
refresh.

## Usage (caller's view)

```ts
// composition root
const api = apiResource({
  resource: config.apiResource,
  issuer: config.issuer,
  jwksUrl: `${config.authInternal}/auth/jwks`,
  fetch,
});
const client = createOAuthClient({
  auth: api,
  client: { id: "bbs", secret: config.clientSecret },
  origin: config.appOrigin, // https://bbs.herkules.dev — NOT the platform origin
  cookieSecret: config.cookieSecret,
  issuerInternal: `${config.authInternal}/auth`,
  fetch,
});

// app
const oauth = honoOAuth(client);
const app = new Hono<ViewerEnv>();
app.route("/", oauth.routes); //           GET /login  GET /callback  POST /logout
app.use("/api/*", oauth.viewer()); //      c.var.principal?: Principal
app.post("/api/notes", oauth.guard({ role: "member" }), h); // c.var.principal: Principal
app.on(["GET", "POST", "DELETE"], "/mcp/bbs", honoAuth(mcp), m); // bearer only, same variable
```

`/api/viewer` under `viewer()` returns `null` for anonymous and, for a member,
`{ id: principal.subject, role, displayName }` with display data fetched from
the user-info API using `principal.token` (as `services/mcp-directory` does);
`/api/me` sits behind `guard({ role: "member" })` and answers 401 to nobody.
Login is `<a href="/login?next=…">`; logout is a POST form. Tests use
`createFakeIssuer()` and `issuer.signIn(app, { subject, role })`.

## Shape

**Data structures decide everything.**

- Session cookie = `{ accessToken, refreshToken }`, nothing else. No subject,
  no role (identity is re-derived by verification), no expiry (the token's
  `exp` is the expiry; `principal.expiresAt` after verification is the only
  clock input). One source of truth per invariant.
- Login cookie = a bounded list (3) of `{ state, codeVerifier, next: SafePath, issuedAt }`,
  10-minute TTL, matched by `state` and removed on use. A record would make a
  second tab's login break the first; a list makes concurrent logins work and a
  replayed callback fail locally.
- `SafePath` is a branded type made only by `safePath()`: an unvalidated
  `next` cannot reach a `Location` header.
- `Sealed<P>` brands a cookie value with the purpose it may be opened as,
  backing at compile time the AEAD purpose separation enforced at runtime.
- `SessionOutcome` is `{ ok: true, principal, via, setCookie? } | { ok: false, failure, response, setCookie? }`
  with a closed three-way `SessionFailure`: `anonymous(reason)` (nobody),
  `denied(AuthFailure)` (somebody, not enough — or an invalid presented bearer),
  `unavailable(cause)` (cannot say; keep the cookie). `setCookie` is explicit
  data on the outcome, applied by the transport on every branch.

**The verifier is passed in, not rebuilt.** `createOAuthClient({ auth })`
takes the `ResourceAuth` the app already built. "A browser and an agent get
the same `Principal`" is a fact about one object, not a convention, and
`issuer` / `resource` / `jwksUrl` / clock tolerance / verification `fetch`
cannot drift because they are not duplicated. Every failure Response comes from
auth-middleware's renderer, so the wire format keeps one home.

**Refresh policy** (session.ts): refresh when the verified token is within
60 s of expiry (the verifier's tolerance — a token we serve is never one the
user-info API would reject moments later) or already `expired`. Single-flight
per refresh-token value, plus a 30 s memo of successful rotations equal to the
issuer's replay window (a constant, not an option). Rejected → signed out,
cookie cleared, no retry. Unavailable while the old token still verifies →
serve it (graceful inside tolerance). `client_auth` (our secret is wrong) →
event + unavailable, never the user's fault.

**Bearer precedence**: a presented `Authorization` header is authoritative —
the cookie is not consulted, and an invalid bearer is `denied` even under
`viewer()`. An agent's request can never mutate a browser's session.
Defense in depth: cookie auth on a non-GET request marked
`Sec-Fetch-Site: cross-site` is anonymous (SameSite=Lax is the primary control).

**Optional vs required is a type, not a branch.** `viewer()` contributes
`{ principal?: Principal }`, `guard()` contributes `{ principal: Principal }`
(auth-middleware's `AuthEnv`); Hono 4.13 intersects per route (tsc probe,
2026-08-28: guarded route narrows, unguarded route rejects). `guard()` under a
`viewer()` mount reuses the already-resolved principal and re-checks only the
requirement through `auth.verifyToken(principal.token, require)`, so role
denials render identically for cookie and bearer callers.

**Endpoints derived, not discovered.** The issuer is ours and its paths are
fixed; discovery at boot would be a startup network dependency for no
information. `Endpoints` is the seam a `discover()` would fill.

**Sealing**: AES-256-GCM; key = HKDF-SHA256(cookieSecret, salt = clientId,
info = purpose); purpose also bound as AAD; `v1.` prefix. WebCrypto only.
Unknown version / wrong key / tamper → "absent".

**Validation at boundaries**: `createOAuthClient` (TypeError at boot),
`safePath` (untrusted `next`), `cookie.ts` open + shape (untrusted cookie),
`issuer.ts` (untrusted token JSON), `auth.verifyToken` (the token). Inside,
types are trusted.

**Interface depth.** Public: `createOAuthClient(options)` → `{ auth, redirectUri, authenticate, beginLogin, completeLogin, logout }`;
`honoOAuth(client, { onLoginFailure? })` → `{ routes, viewer(), guard() }`;
`createFakeIssuer`. Hidden: PKCE/state, the authorize query, `client_secret_basic`,
the token wire format and error taxonomy, the "no `resource` on the token
request" rule, cookie format and crypto, refresh timing, single-flight and the
replay memo, bearer precedence, the cross-site guard, and the mapping of every
failure onto auth-middleware's bodies. Exposed: credentials, origin, cookie
secret, internal issuer address, and — per route — whether anonymous is fine.
No wire type is exported.

**Deliberately not done**: discovery, OIDC / `id_token` (the name says
`oauth-client` on purpose), RP-initiated logout (`end-session` needs an
`id_token_hint` this resource never gets), DCR, public/PKCE-only clients,
proactive background refresh, user profiles (forward `principal.token`),
any database, HTML, logger, CSRF tokens, rate limiting, multi-replica
coordination, configurable paths or cookie names.

## Synthesis decision

Two candidates (Fable = A, Opus = B), structurally distinct, both screened
against the red-flag list.

Base: **B's structural decisions** — the verifier passed in (`auth`), the
two-string cookie with the refresh trigger derived from verification, the
bounded login-attempt list, `deny.unavailable` added upstream in
auth-middleware instead of a synthetic-request rendering hack, and the
`viewer()` / `guard()` verbs.

Grafted from **A**: the explicit `SessionOutcome` with `setCookie` as data
(B's per-`Request` WeakMap memo plus a single-use `drainCookies()` was a hidden
protocol callers had to know — red flag: learning the interface does not save
learning the implementation); the closed three-way `SessionFailure`
(B folded denied/unavailable into `anonymous{failure, denial()}`); the
bearer-authoritative rule stated once (B's docs contradicted themselves:
"cookie first" vs "header wins"); the `Sec-Fetch-Site` guard; the
framework-neutral core with `login.ts` as pure functions; fixed paths and
cookie names; the `unavailable`-with-fallback graceful path.

Rejected: A's `createOAuthClient` building its own `apiResource` (two verifiers
per process, five duplicated options); A's stored `accessExpiresAt`/`obtainedAt`
(the verified token already carries expiry; refresh-ahead is kept but derived);
B's `paths`, `cookiePrefix`, `secure`, `scope`, `defaultNext` options (they
expose implementation choices; cookies are host-only so prefixes cannot
collide); B's `browserSession → createSession` forwarding (admitted
pass-through). Kept from B as small seams: `now` and `onEvent`.

## Tradeoffs accepted

- A JWT verification on every request (Ed25519, JWKS cached in-process) in
  exchange for no store, no invalidation, one code path with bearer callers.
- A guarded route under `viewer()` verifies the requirement twice (cheap) in
  exchange for role/scope denials rendered by exactly one renderer.
- Refresh ~60 s before expiry (every ~14 min of activity) in exchange for
  never serving a token another resource server would reject.
- Single-process rotation state; a second replica would fall back to the
  issuer's replay window. One replica by decision; sticky sessions at Caddy is
  the fix if that changes, not shared state here.
- A crash mid-refresh may sign one browser out (issuer replay covers 30 s).
- `viewer()` shows an outage as "anonymous" (readers keep reading, members look
  signed out; cookie kept) in exchange for anonymous reads never failing
  because the issuer is down. `guard()` says 503.
- Rotating `cookieSecret` signs everyone out — the intended emergency lever.
- Encrypting, not merely signing, the cookie (one AEAD per request) so refresh
  tokens never sit readable in a cookie-jar export.
- POST-only logout; a plain `<a href="/logout">` does not work.
- Three concurrent half-finished logins per browser, not unlimited.

## Alternatives considered

- **Session table, opaque id in the cookie.** The FRAME rejected it; it costs
  each adopter a migration, a cleanup job and a backup line for revocation the
  15-minute access token already bounds. Worse interface: the adopter operates
  a store.
- **A `Viewer` union as the context variable.** Forces every handler,
  including those shared with MCP, to narrow before touching identity — a
  second identity shape next to `Principal`.
- **Discovery at boot.** Standards-correct, but a startup dependency on a
  service that may boot after us, for endpoints the issuer URL fully determines.
- **Browser PKCE public client.** Refresh tokens in the browser; rejected in
  `apps/bbs/FRAME.md`.
- **Signed (HMAC) cookie.** Refresh token readable by anyone who reads the jar.
- **Cookie-only middleware, bearer via a separate `honoAuth` beside it.** Leaves
  precedence and "invalid bearer must not become anonymous" to each adopter.

## Changes outside this package (same change set)

1. `packages/auth-middleware`: `deny.unavailable(reason): Response` — renders
   the existing `jwks_unavailable` failure (503, `Retry-After`, no challenge).
   No new failure kind, no new wire format; three lines in `index.ts`.
2. `services/auth/src/clients.ts`: `FIRST_PARTY_CLIENTS` becomes a
   discriminated union — public (`tokenEndpointAuthMethod: "none"`, no secret)
   vs confidential (`"client_secret_basic"`, `grantTypes: ["authorization_code","refresh_token"]`,
   `secret: (config) => string | undefined`) — with `redirectUris: (config) => string[]`
   so an origin other than `PUBLIC_ORIGIN` is expressible. Entry:
   `{ clientId: "bbs", name: "RM 文库", redirectUris: c => c.BBS_ORIGIN ? [`${c.BBS_ORIGIN}/callback`] : [], secret: c => c.BBS_CLIENT_SECRET, skipConsent: true, applicationType: "native", … }`
   (`native` because the dev origin is http-loopback; verify `web` is not
   needed for the https prod redirect). Seeding writes `clientSecret` hashed
   and reconciles every field, not only redirect URIs and metadata (a
   half-deployed row with the wrong auth method would 401 forever). Entries
   whose origin or secret is unset are skipped with a log line.
3. `services/auth/src/secrets.ts`: `hashClientSecret` / `verifyClientSecret`
   = `base64url(SHA-256(secret))`, no padding, constant-time compare — the same
   format as Better Auth's unexported `defaultHasher`; passed to the plugin as
   `storeClientSecret: { hash, verify }` so one function is the truth.
4. `services/auth/src/config.ts`: `BBS_ORIGIN` (url → origin, optional) and
   `BBS_CLIENT_SECRET` (≥ 32, optional), both-or-neither.
5. `services/auth/src/registry.ts`: `{ name: "bbs", kind: "api", title: "RM 文库" }`,
   `{ name: "bbs", kind: "mcp", title: "RM 文库 (MCP)" }`.

## Verification (the FRAME kill-criterion probes) — all pass

`services/auth/tests/first-party.test.ts`, against the real Better Auth issuer
on PGlite. Facts established:

1. A directly inserted row with `tokenEndpointAuthMethod: "client_secret_basic"`
   and a hashed `clientSecret` is accepted by `/oauth2/token` with
   `Authorization: Basic`; `client_secret` in the body and a wrong secret are
   both refused with `invalid_client`. Better Auth burns the authorization code
   on a failed attempt (RFC 6749 §4.1.2), so a retry needs a new authorize.
2. `resource=<api/…>&scope=offline_access` yields a refresh token, a
   single-string `aud` and no `id_token`; `/oauth2/authorize` with a signed-in
   session 302s straight to `${BBS_ORIGIN}/callback?code=` — no consent page.
3. `trustedOrigins` never sees the authorize request (GET) and the token
   request carries no cookie, so the origin check does not run; a
   `redirect_uri` on another origin is accepted as long as it matches the row
   exactly (`findRegisteredRedirectUri`; loopback IPs get port variance).
4. The stored `applicationType` only gates DCR validation; a seeded row holding
   both `https://bbs.…/callback` and `http://localhost:3003/callback` completes
   the flow with either.
5. `mcp()` spreads its options into `oauthProvider`, so `storeClientSecret:
clientSecretStore` is honoured: the plugin calls our `verify` at the token
   endpoint (spied), and a row hashed by `hashClientSecret` verifies.

## Decisions (were open questions at the checkpoint)

- Callback failure renders as JSON `{ error, error_description }` with the
  failure's status (400 / 502 / 503). `onLoginFailure` lets bbs redirect to its
  own page instead; cookies are applied to whatever it returns.
- `viewer()` does not signal an issuer outage to the SPA: an `unavailable`
  session with no still-valid access token is anonymous on the wire (cookie
  kept, `onEvent` sees `unavailable`), `guard()` returns 503. No new header or
  wire contract in v1; revisit if the SPA needs "sign-in temporarily
  unavailable".

## Deviations from the sketch (Phase D)

- `RefreshCoordinator.refresh` returns `{ result, fromMemo }` instead of a bare
  `GrantResult`: the `refreshed` event promised `fromMemo` and the coordinator
  is the only place that knows. Internal; not exported.
- `FakeIssuer.signIn(app)` takes `{ request: Hono["request"] }` rather than
  `Hono`: an app typed `Hono<ViewerEnv>` is not assignable to `Hono<BlankEnv>`.
- `LoginFailure.error` also carries `invalid_request` (callback with neither
  `code` nor `error`) and passes the issuer's own authorize error through
  verbatim instead of collapsing every one to `access_denied`.
- The `login_completed` event reads `sub` from the freshly issued token
  without verifying it (`unverifiedSubject`); the token was received over the
  authenticated back-channel and is verified on the next request anyway.
  Verifying in `login.ts` would have needed `auth` there — rejected.
- `createOAuthClient` requires `issuerInternal` to be http(s): `new URL("auth:3001")`
  parses, so "absolute" alone was not a check.
- Bearer failures are `denied` verbatim, including a 503 from JWKS: "the
  verifier's outcome, unchanged" is the rule; `viewer()` therefore returns the
  verifier's response for ANY failed bearer.
- `ensureFirstPartyClients` grew an optional `log` parameter (default
  `console.log`) for the "entry skipped" line.

## Next step

Adopt in `apps/bbs`: `BBS_ORIGIN` + `BBS_CLIENT_SECRET` on the box, the
composition root from the usage section, and an end-to-end test that drives
this package against `@herkules/auth/testing` (the fake issuer's contract is
`tests/`; the real issuer's is `services/auth/tests/first-party.test.ts`).
