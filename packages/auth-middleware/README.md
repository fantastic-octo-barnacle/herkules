# Auth middleware

`@herkules/auth-middleware` verifies Herkules access tokens in TypeScript resource servers. It returns a typed `Principal` and renders the OAuth challenge and error response defined by [`../../docs/tokens.md`](../../docs/tokens.md).

Exports cover framework-neutral verification, Hono middleware, MCP auth information, user-info calls, and test issuers. See `package.json` for the current subpaths.

## Run and test

```sh
vp test
vp check
vp run build
vp run vectors
```

`vp run vectors` regenerates `../../docs/tokens-vectors.json`. Commit vector changes only with an intentional token-contract change. `uv run ../../docs/verify_token.py` checks the language-neutral reference verifier.

## Decisions that bind

- [`../../docs/tokens.md`](../../docs/tokens.md) is authoritative. This package implements that contract and must not add a TypeScript-only authentication policy.
- `src/principal.ts` owns the identity passed to handlers. `subject` from `sub` is the only per-user storage key. Roles are the closed set `admin | member`; missing or unknown roles fail closed.
- `src/verify.ts` pins `alg` to EdDSA, `typ` to `at+jwt`, the exact issuer and resource audience, required claims, and a 60-second default clock tolerance capped at 300 seconds. It caches JWKS for five minutes, rate-limits unknown-key refreshes to 30 seconds, and times fetches out after five seconds.
- A JWKS outage is 503 when no usable key set exists. It is never 401. A permission failure is 403 without a challenge. `src/challenge.ts` is the only writer of `WWW-Authenticate`.
- `mcpResource()` and `apiResource()` are separate constructors because their error bodies differ. The framework-neutral verifier is the core; Hono and MCP are adapters.
- Bearer tokens carrying `cnf` and the `DPoP` authorization scheme are rejected until the contract changes.
- The raw token remains on `Principal` so a resource server can call user-info on the caller's behalf. Never log it.

## Minimal Hono use

```ts
import { apiResource } from "@herkules/auth-middleware";
import { honoAuth, type AuthEnv } from "@herkules/auth-middleware/hono";
import { Hono } from "hono";

const auth = apiResource({
  resource: "https://herkules.dev/api/example",
  issuer: "https://herkules.dev/auth",
});
const app = new Hono<AuthEnv>();
app.use("/api/*", honoAuth(auth));
app.get("/api/me", (c) => c.json({ id: c.var.principal.subject }));
```

Use `src/testing.ts` through the `/testing` export for unit tests. The conformance suite is in `tests/vectors.test.ts` and `tests/contract.test.ts`.
