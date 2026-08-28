# Design: @herkules/auth-middleware — 2026-08-28

Synthesized from three independent candidate designs (see "Synthesis decision").
Status: type sketch; bodies are `not implemented`. Implementation fills in against this contract.

## Problem

Resource servers — MCP servers on `@modelcontextprotocol/server` and plain HTTP
APIs — run in their own containers and must accept herkules access tokens
without talking to the auth service per request. Each must verify a JWT
(EdDSA, `typ: at+jwt`, issuer `https://herkules.dev/auth`, `aud` = its own
canonical URL) against the issuer's JWKS, hand its handlers a typed principal,
and answer failures with the exact `WWW-Authenticate` challenge MCP clients use
to start the OAuth flow. Constraints from FRAME.md and the grounding: the
language-neutral contract in `docs/tokens.md` is authoritative and this package
must be an implementation of it, not a superset; v1 has no scopes, no M2M
tokens, and no DPoP, but all three must be representable without redesign; a
role denial must never carry a challenge (re-authorizing cannot fix it) and a
JWKS outage must never be reported as 401 (it would send every IDE client back
through consent at once); the MCP SDK 2.0 web-standard transport takes
`handleRequest(request, { authInfo })`; a 30-line server must stay 30 lines.

## Usage (caller's view)

Install: `vp add @herkules/auth-middleware` (workspace). Subpaths: `/hono`, `/mcp`, `/testing`.

MCP server (Hono + `@modelcontextprotocol/server`):

```ts
import { mcpResource } from "@herkules/auth-middleware";
import { toAuthInfo, principalOf } from "@herkules/auth-middleware/mcp";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";

const auth = mcpResource({
  resource: process.env.RESOURCE_URL!, // https://herkules.dev/mcp/directory
  issuer: process.env.ISSUER!, // https://herkules.dev/auth
});

const server = new McpServer({ name: "directory", version: "0.1.0" });
server.tool("whoami", {}, async (_args, extra) => {
  const me = principalOf(extra.authInfo);
  return { content: [{ type: "text", text: `${me.subject} (${me.role})` }] };
});
server.tool("purge_cache", {}, async (_args, extra) => {
  if (principalOf(extra.authInfo).role !== "admin") {
    return { isError: true, content: [{ type: "text", text: "admin only" }] };
  }
  /* ... */
});

const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

const app = createMcpHonoApp();
app.all("/mcp/directory", async (c) => {
  const outcome = await auth.authenticate(c.req.raw);
  if (!outcome.ok) return outcome.response;
  return transport.handleRequest(c.req.raw, {
    parsedBody: c.get("parsedBody"),
    authInfo: toAuthInfo(outcome.principal),
  });
});
```

Plain HTTP API (Hono, with the adapter and a route-level requirement):

```ts
import { apiResource } from "@herkules/auth-middleware";
import { honoAuth, type AuthEnv } from "@herkules/auth-middleware/hono";

const auth = apiResource({ resource: "https://herkules.dev/api/notes", issuer });
const app = new Hono<AuthEnv>();
app.use("/api/notes/*", honoAuth(auth));
app.get("/api/notes", (c) => c.json(listNotes(c.var.principal.subject)));
app.delete("/api/notes/:id", honoAuth(auth, { role: "admin" }), (c) => {
  /* ... */
});
app.get("/api/notes/:id", async (c) => {
  const note = await loadNote(c.req.param("id"));
  if (note.owner !== c.var.principal.subject) return auth.deny.permission("not your note");
  return c.json(note);
});
```

Raw fetch handler (no framework):

```ts
export default {
  async fetch(request: Request) {
    const outcome = await auth.authenticate(request, { role: "member" });
    if (!outcome.ok) {
      log.warn(outcome.failure);
      return outcome.response;
    }
    return Response.json({ hello: outcome.principal.subject });
  },
};
```

Unit test of a resource server, no auth service running:

```ts
import { createTestIssuer } from "@herkules/auth-middleware/testing";

const issuer = await createTestIssuer();
const auth = mcpResource({
  resource: "https://test.invalid/mcp/x",
  issuer: issuer.issuer,
  fetch: issuer.fetch,
});

test("wrong audience is invalid_token", async () => {
  const token = await issuer.mint({ audience: "https://test.invalid/mcp/other" });
  const out = await auth.verifyToken(token);
  expect(out.ok).toBe(false);
  expect(out.failure).toEqual({ kind: "invalid_token", reason: "wrong_audience" });
  expect(out.response.status).toBe(401);
  expect(out.response.headers.get("www-authenticate")).toBe(
    'Bearer error="invalid_token", resource_metadata="https://test.invalid/.well-known/oauth-protected-resource/mcp/x", error_description="invalid token"',
  );
});

test("rotation is honoured without a restart", async () => {
  await issuer.rotate();
  const out = await auth.verifyToken(await issuer.mint({ audience: "https://test.invalid/mcp/x" }));
  expect(out.ok).toBe(true);
  expect(issuer.jwksFetches).toBe(2);
});
```

## Shape

Data first. `Principal` (principal.ts) is the domain object every handler
sees: `subject` (the only storage key), `role: "admin" | "member"`,
`clientId`, `resource`, `scopes: ReadonlySet`, `issuedAt`, `expiresAt`,
`tokenId`, `sessionId?`, raw `token`, and a read-only `claims` bag as the
escape hatch for claims not yet promoted. A missing or unknown `role` is
rejected as `invalid_token` — fail closed; a future M2M token is a contract
change, not a silent default. `AuthFailure` (failure.ts) is a closed union of
six kinds; adding one forces `renderFailure` to handle it.

Flow: `authenticate(request, require?)` → `parseAuthorization` →
`TokenVerifier.verify` (jose `jwtVerify` with pinned `algorithms: ["EdDSA"]`,
`typ: "at+jwt"`, issuer, audience, clock tolerance, required claims; one
`createRemoteJWKSet` per instance; every jose error classified into a reason)
→ `principalFromClaims` → the optional `Requirement` check → on any failure,
`renderFailure(failure, ctx)` builds the Response. The failure branch of
`AuthOutcome` carries both `failure` (for logs) and `response` (to return), so
nobody re-derives a status code.

Load-bearing decisions:

- `mcpResource` / `apiResource` constructors, not an options flag: the caller
  states what they are; body style (JSON-RPC vs JSON) and URL strictness
  follow. Per boundary-discipline the resource URL is validated once, at boot.
- Authorization is declared, not constructed. `Requirement { role?, scopes? }`
  has different names and value types for the two 403s, and `deny.permission`
  vs `deny.scope` keep them apart for post-fetch checks. With the scope
  vocabulary `S` defaulting to `never`, `deny.scope` is uncallable and
  `scopes: []` is the only legal requirement — "no scopes in v1" lives in the
  types, per encode-lessons-in-structure.
- `jose` directly, not `better-auth/oauth2`: no `APIError` on our surface, no
  module-global JWKS cache, no three-package footprint in every resource image,
  and the code reads like `docs/tokens.md` — which it must, since Python and
  Rust authors follow the same text.
- `fetch` is the single injected seam. It makes `createTestIssuer()` an
  in-memory function and lets tests exercise the real cache/rotation path
  instead of bypassing it with a static key set.
- MCP integration is a subpath with a structural `McpAuthInfo` type, not an SDK
  import; the whole principal rides in `extra.herkules` and `principalOf` hands
  it back, so tool handlers never re-derive fields from the lossy `AuthInfo`.
- `challenge.ts` is the only writer of `WWW-Authenticate`; `error_description`
  distinguishes only "expired" from a generic string (a finer one is a probing
  oracle); the precise reason is in `failure`.

Interface depth: the public surface is two constructors, one method (plus a
token-string twin), two `deny` helpers, and the `Principal`/`AuthFailure`
types. Behind it: header parsing, JWKS fetch/cache/rotation, RFC 9068/6750/9728
policy, error classification, and challenge grammar. What stays exposed is only
what a handler genuinely needs — who is calling, and a Response when they may
not. The system deliberately does not: serve protected-resource metadata
(the auth service does, from the registry), accept DPoP or opaque tokens, or
offer a body-format option.

## Synthesis decision

Base: candidate 2 (opus) — `authenticate(request, require?)`, the
`mcpResource`/`apiResource` split, the closed `AuthFailure` union with
`jwks_unavailable → 503`, `deny.permission`/`deny.scope` with `S = never`, the
`fetch` seam, principal-in-`extra`. (`deny.unavailable` was added 2026-08-28
for `@herkules/oauth-client`: same 12.5 rendering, for a caller whose own
upstream — the token endpoint — is down.)
Grafted from candidate 1 (fable): fail-closed rejection of a missing `role`
(c2 collapsed it to `member`, which still grants authority to an unknown token
kind); the richer test issuer (`rotate`, `retireOldKeys`, `jwksFetches`,
negative-test mint options); `verifyToken` for non-HTTP contexts; the
`tests/contract.test.ts` idea that pins `docs/tokens.md`'s literal strings;
the 17-section tokens.md outline.
Grafted from candidate 3 (sonnet): `roleSatisfies` as the one exported pure
helper for tool-handler checks; the "contract standardizes status + headers,
body style is the server's" framing.
Rejected: c1's hand-rolled JWKS cache (its motivation — jose's 30 s cooldown
after a reload — is real but only bites if a rotation lands inside that window,
rotation is off by default, and it self-heals; documented instead); c1's thrown
`PermissionDenied`/`InsufficientScope` guards (a Response-returning API is
usable in raw fetch handlers without an adapter to render exceptions); c1's
required `errorBody` option (constructor choice is the same information with
no way to pick wrong); c3's `Role | undefined`; c3's static-JWKS-only test
issuer; c2's `userId` naming (wrong for a future client-credentials subject).

## Tradeoffs accepted

- We accept jose's ≤30 s window where a token signed by a key rotated
  immediately after a JWKS reload is rejected, in exchange for not owning a
  key cache. Documented in tokens.md §9.
- We accept a 503 (rather than serving a stale key set) when the JWKS fetch
  fails after the cache expires, in exchange for the same simplicity; the
  auth service is on the same box, and a 503 is honest.
- We accept a `ResourceAuth` object callers construct once and hold, in
  exchange for JWKS caching actually caching.
- We accept the generic `S` on `ResourceAuth` (noise in a type annotation
  nobody writes) in exchange for scope misuse being a compile error in v1.
- We accept that MCP tool-level authorization is a plain `role` comparison plus
  the SDK's own tool-error shape, not a package helper: an HTTP 403 has no
  meaning inside a JSON-RPC tool result.
- We accept maintaining `McpAuthInfo` by hand against an alpha SDK, in exchange
  for the core having no SDK dependency.

## Alternatives considered

- Wrap `better-auth/oauth2`'s `verifyAccessTokenRequest` + `createResourceServerChallenge`:
  hides the most (DPoP included) behind an equally small surface, but leaks
  `APIError`, drags the auth framework into every resource image, and makes
  the TS path structurally unlike the contract Python/Rust follow. Lost.
- Caddy `forward_auth` so servers read `X-User-Id`: smallest per-server code,
  but servers only work behind this Caddy and the 401 challenge still has to
  be produced somewhere. Lost (already rejected in FRAME.md).
- Hono-first package: the SDK transport is already Request/Response-native;
  a Hono-first core would adapt the wrong way round. Lost.
- One `check(principal, { role?, scope? })` returning a Response: hides the
  role/scope distinction from the signature — the exact bug we are preventing.
  Lost.

## Decisions taken at implementation (2026-08-28)

- Package name: scoped `@herkules/auth-middleware`.
- Clock tolerance default 60 s (cap 300 s, a `TypeError` above it).
- Conformance vectors are checked in (`docs/tokens-vectors.json`, test-only
  key pair) and run by both `tests/vectors.test.ts` and `docs/verify_token.py`
  (`uv run docs/verify_token.py`); regenerate with `vp run vectors`.
- Local dev is single-origin, so the RFC 9728 derivation holds unmodified.
- `typ`/`alg`/`kid` are checked from the decoded header BEFORE any JWKS
  access; `iat` in the future is checked explicitly (jose only does so under
  `maxTokenAge`); when a JWKS refetch fails but a previously loaded set exists,
  that set is used instead of answering 503.
- 111 tests; `services/auth`'s integration suite verifies a token the real
  Better Auth minted through this package and rejects it for another audience.

## Open questions and risks

- Package name: scoped `@herkules/auth-middleware` (as sketched) or unscoped
  like `packages/utils`? Recommendation: scoped, and rename `utils` later.
- Clock tolerance default 60 s (cap 300 s in tokens.md): enough for the
  mainland-side machines, or should the default be 120 s?
- Should `docs/tokens.md` ship checked-in conformance vectors (a test key pair
  - sample tokens + expected outcomes) that both `tests/contract.test.ts` and
    the Python reference verifier are run against? Recommendation: yes; the key
    pair is test-only and lives in `docs/`.
- MCP SDK 2.0 is alpha: `handleRequest(request, { authInfo })` and `AuthInfo`
  were read from `main` today; pin the exact version when `services/mcp-directory`
  is scaffolded and re-check `mcp.ts` against it.
- Local dev is single-origin behind Caddy (so the RFC 9728 derivation holds and
  `resourceMetadataUrl` never needs overriding) — confirm that is the intended
  dev topology.

## Next implementation step

Done. Next consumer: `services/mcp-directory` (the first real resource server).
