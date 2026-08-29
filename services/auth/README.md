# Auth service

`@herkules/auth` is the authorization server at `https://herkules.dev/auth`. It wraps Better Auth 1.7.2 in Hono, admits GitHub users through the team gate, issues audience-bound EdDSA access tokens, and owns users, roles, allowlisting, OAuth clients, protected-resource metadata, avatars, and the audit log.

The cross-service model is documented in [`../../docs/auth.md`](../../docs/auth.md). Resource servers must follow [`../../docs/tokens.md`](../../docs/tokens.md).

## Run and test

Copy `.env.example` to `.env`, fill the GitHub OAuth and database settings, then run:

```sh
vp run dev
vp test
vp check
vp run build
```

Development accepts `pglite://` database URLs. Production uses Postgres and applies the checked-in Drizzle migration at boot. See [`../../tools/deploy/README.md`](../../tools/deploy/README.md) for the deployed stack.

## Decisions that bind

- `src/registry.ts` is the only owner of resource names, canonical audience URLs, protected-resource metadata URLs, allowed scopes, and access-token TTLs. A registry entry is a reviewed code change. Exactly one MCP resource is canonical, and a resource TTL may shorten but not exceed 900 seconds.
- Registry resources allow only `offline_access`. This produces refresh tokens and keeps access-token `aud` a single resource URL. `src/auth.ts` owns the issuer-wide OAuth vocabulary and token hooks.
- `src/gate.ts` owns admission. The precedence is disabled user, environment admin, allowlist, then GitHub organization membership. Allowlisted users do not depend on GitHub. Grant-time checks fail closed subject to the configured stale-org grace.
- `ADMIN_GITHUB_LOGINS` seeds administrators but never demotes a user. `src/users.ts` owns role changes, disabling, session and client revocation, the last-admin and self-demote guards, and their transactions.
- An admin may not remove their own authority: `setRole` refuses a self-demotion (403 `self_demote`) and `setDisabled` refuses a self-disable (403 `self_disable`). Both are checked after the last-admin guard, not before — an admin demoting another admin always leaves two active admins, so 409 `last_admin` is reachable only through the same self-call, and reversing the order would make it dead code. A system actor still passes both.
- Every authority-changing write must produce an awaited audit row. Add plugin events to the exhaustive table in `src/audit.ts`; add administrative changes through `src/users.ts`. Do not add an unaudited Better Auth admin route.
- Browser sessions do not use Better Auth's cookie cache. Disabling a user must take effect on the next request.
- `src/clients.ts` owns first-party clients and native-client redirect quirks. DCR is enabled for IDE clients. CIMD stays unmounted — the deployed host cannot fetch client metadata documents — and Claude Code's CIMD path is broken regardless: its `localhost` callback registers without the port the authorize request carries, and the matcher grants port variance to `127.0.0.1`/`[::1]` only. [`../../docs/auth.md`](../../docs/auth.md) owns the full record.
- User-info accepts a session or a JWT for any registered audience. Callers key data by the opaque `sub`; GitHub IDs, names, and avatars are display data.
- The service owns every RFC 9728 protected-resource metadata document. Resource servers emit its URL in challenges but do not serve competing copies.

## Code map

- `src/auth.ts`: Better Auth configuration, grants, claims, disabled routes
- `src/registry.ts`: resource and audience policy
- `src/gate.ts`, `src/github.ts`: admission evidence and GitHub checks
- `src/users.ts`, `src/bearer.ts`: administrative writes and caller identification
- `src/audit.ts`: audit event vocabulary and plugin hooks
- `src/clients.ts`, `src/secrets.ts`: first-party client registration and secret hashing
- `src/avatars.ts`: the GitHub-avatar cache served at `/auth/avatars/:userId` — stored on a volume, refreshed at login and on miss, `ETag`/`If-None-Match`; a stale entry is never a 5xx
- `src/app.ts`: Hono routes, metadata, user-info, avatars, and health
- `src/config.ts`: environment boundary
- `tests/`: end-to-end issuer, client, gate, and audit behavior
