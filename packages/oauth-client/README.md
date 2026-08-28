# OAuth client

`@herkules/oauth-client` signs browsers into a first-party Hono app through the Herkules issuer. It gives browser sessions and bearer callers the same `Principal` from `@herkules/auth-middleware`, without a session table.

It provides fixed `/login`, `/callback`, and POST `/logout` routes plus optional `viewer()` and required `guard()` middleware.

## Run and test

```sh
vp test
vp check
vp run build
```

The real confidential-client exchange is also covered by `../../services/auth/tests/first-party.test.ts`.

## Decisions that bind

- Callers pass an existing `ResourceAuth` to `createOAuthClient`. The package never constructs a second verifier or a second identity type.
- The session cookie contains only access and refresh tokens. AES-256-GCM sealing uses HKDF-SHA256 with separate purposes; `BBS_COOKIE_SECRET`-style secrets must be at least 32 characters. Rotating the cookie secret signs everyone out. See `src/seal.ts` and `src/cookie.ts`.
- Browser clients are confidential OAuth clients using authorization code, PKCE, `client_secret_basic`, and `offline_access`. The callback path is fixed at `/callback`; the issuer endpoints derive from the public and internal issuer URLs.
- `Authorization` takes precedence over cookies. An invalid presented bearer token remains an explicit denial and never falls through to an anonymous browser session.
- `viewer()` may treat an unavailable issuer as anonymous while retaining the cookie. `guard()` returns 503. Cross-site non-safe requests cannot authenticate with the cookie.
- `src/session.ts` refreshes within 60 seconds of access-token expiry. Refresh is single-flight per refresh token, and successful rotations are memoized for the issuer's fixed 30-second replay window. These constants must stay aligned with `services/auth/src/auth.ts`.
- Login state is a sealed, ten-minute list of at most three concurrent attempts. `src/login.ts` accepts only local safe paths for `next`.
- The package does not own profiles, HTML, rate limiting, discovery, DCR, or a database. Apps forward `principal.token` to the auth user-info API when they need display data.

## Code map

- `src/index.ts`: public API and fixed endpoints
- `src/session.ts`: bearer and cookie precedence, verification, refresh
- `src/login.ts`, `src/issuer.ts`: PKCE flow and token endpoint client
- `src/cookie.ts`, `src/seal.ts`: cookie format and encryption
- `src/hono.ts`: routes and middleware
- `src/testing.ts`: fake issuer for adopters
