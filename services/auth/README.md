# Auth service

`@herkules/auth` is the authorization server at `https://herkules.dev/auth`. It wraps Better Auth 1.7.4 in Hono, admits GitHub users through the team gate, issues audience-bound EdDSA access tokens, and owns users, roles, allowlisting, OAuth clients, protected-resource metadata, avatars, and the audit log.

The cross-service model is documented in [`../../docs/auth.md`](../../docs/auth.md). Resource servers must follow [`../../docs/tokens.md`](../../docs/tokens.md).

## Run and test

Copy `.env.example` to `.env`, fill the GitHub OAuth and database settings, then run:

```sh
vp run dev
vp test
vp check
vp run build
```

Development accepts `pglite://` database URLs. Production uses Postgres and applies the checked-in Drizzle migration at boot. See [`../../tools/deploy/README.md`](https://github.com/fantastic-octo-barnacle/herkules-infra/blob/main/tools/deploy/README.md) for the deployed stack.

## Decisions that bind

- `src/registry.ts` is the only owner of resource names, canonical audience URLs, protected-resource metadata URLs, allowed scopes, and access-token TTLs. A registry entry is a reviewed code change. Exactly one MCP resource is canonical, and a resource TTL may shorten but not exceed 900 seconds.
- Registry resources allow only `offline_access`. This produces refresh tokens and keeps access-token `aud` a single resource URL. `src/auth.ts` owns the issuer-wide OAuth vocabulary and token hooks.
- `src/gate.ts` owns admission. The precedence is disabled user, environment admin, allowlist, then GitHub organization membership. Allowlisted users do not depend on GitHub. Grant-time checks fail closed subject to the configured stale-org grace.
- `ADMIN_GITHUB_LOGINS` seeds administrators but never demotes a user. `src/users.ts` owns role changes, disabling, session and client revocation, the last-admin and self-demote guards, and their transactions.
- An admin may not remove their own authority: `setRole` refuses a self-demotion (403 `self_demote`) and `setDisabled` refuses a self-disable (403 `self_disable`). Both are checked after the last-admin guard, not before — an admin demoting another admin always leaves two active admins, so 409 `last_admin` is reachable only through the same self-call, and reversing the order would make it dead code. A system actor still passes both.
- Every authority-changing write must produce an awaited audit row. Add plugin events to the exhaustive table in `src/audit.ts`; add administrative changes through `src/users.ts`. Do not add an unaudited Better Auth admin route.
- Browser sessions do not use Better Auth's cookie cache. Disabling a user must take effect on the next request.
- `src/clients.ts` owns first-party clients and native-client redirect quirks. DCR is enabled for IDE clients. CIMD is mounted only when `CIMD_ENABLED` is set (off in production: the deployed host cannot fetch client metadata documents). Better Auth 1.7.3 fixed the `localhost` port-variance matcher that used to break Claude Code's port-less document; `tests/cimd.test.ts` covers that path. CIMD clients bypass the DCR quirks, so consent per client per resource and the optional `CIMD_ALLOWED_ORIGINS` are the only controls over a stranger's document. [`../../docs/auth.md`](../../docs/auth.md) owns the full record.
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

## AI portal

Optional `AI_PORTAL_ORIGIN`, `AI_CLIENT_SECRET` and `AI_SYNC_SECRET` configure the
`herkules-ai` confidential client and private membership endpoint. New API uses
Basic client authentication and does not implement PKCE; only this reconciled
first-party client has `requirePKCE=false`. Other clients retain their requirement.
The exact callback is `${AI_PORTAL_ORIGIN}/oauth/herkules`; identities bind by `sub`.
`POST /auth/internal/ai-membership` requires the dedicated sync secret, accepts at
most 100 IDs, and reports missing/disabled accounts as unavailable. Caddy blocks
this internal route. See [AI setup](../../tools/ai/README.md).

## Cloudflare Access

Set `CLOUDFLARE_TEAM_NAME` (the label before `.cloudflareaccess.com`) and
`CLOUDFLARE_CLIENT_SECRET` together in the auth environment. Boot seeds the
confidential `cloudflare-access` client, requiring PKCE and the exact callback
`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.

OIDC ID tokens use ES256 and include email/email_verified when `email` is granted.
Registry API/MCP access tokens remain EdDSA. Boot provisions any missing signing
algorithm before listening and retains old keys; no database schema migration is
needed. The service currently has one auth process. Configure Cloudflare with
`openid email profile`, PKCE enabled, authorization `/auth/oauth2/authorize`, token
`/auth/oauth2/token`, and JWKS `/auth/jwks` on the public issuer origin. SCIM is not
implemented. Use an Access policy restricted to the Herkules login method: the
issuer's existing admission gate checks team membership on token grants. That policy
is `Herkules team` in `tools/deploy/cloudflare/terraform/access.tf`, so recreating
this identity provider means updating the `oidc_idp_id` variable there. Access
sessions remain valid until their own expiry or explicit revocation.

## LarkAI OpenID Connect

`LARKAI_ORIGIN` and `LARKAI_CLIENT_SECRET` seed the confidential `larkai` client
with the exact `/oidc/callback` redirect and mandatory PKCE. It requests
`openid email profile`. UserInfo adds the current `admin | member` role only
for this client and refuses disabled users. LarkAI checks it on each authenticated
request, so role changes are not copied into a separate app admin list.
