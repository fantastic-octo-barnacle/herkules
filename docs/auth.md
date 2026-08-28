# Authentication model

Herkules uses one self-hosted authorization server at `https://herkules.dev/auth`. GitHub proves the external identity. The auth database owns the stable Herkules user and the `admin | member` role. Resource servers verify short-lived access tokens locally.

[`tokens.md`](tokens.md) is authoritative for token fields, verification, errors, protected-resource metadata, and conformance. This document explains ownership and service interaction.

## Ownership

| Concern                                                   | Owner                                                     |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Users, roles, disabled state, allowlist, GitHub admission | `services/auth/src/gate.ts`, `services/auth/src/users.ts` |
| Resource names, audiences, scopes, token TTLs, metadata   | `services/auth/src/registry.ts`                           |
| OAuth and OIDC endpoints, grants, access-token claims     | `services/auth/src/auth.ts`                               |
| First-party client registration and redirect URIs         | `services/auth/src/clients.ts`                            |
| Resource-server verification and challenges               | `packages/auth-middleware`, governed by `docs/tokens.md`  |
| Browser OAuth sessions in first-party apps                | `packages/oauth-client`                                   |
| Display names, avatars, GitHub IDs                        | Auth user-info API in `services/auth/src/users.ts`        |
| Application data and authorization beyond role            | The consuming app or service                              |

Only the opaque access-token `sub` identifies a user in application storage. `client_id` identifies software for audit. GitHub IDs, display names, and avatar URLs can change and must not become foreign keys.

## Browser flow

The platform SPA uses the auth service's same-origin session cookie. A first-party product such as BBS is a confidential OAuth client:

1. The app starts authorization code with PKCE for its API audience and `offline_access`.
2. The issuer authenticates through GitHub and applies the admission gate.
3. The app exchanges the code with `client_secret_basic` and stores only the access and refresh tokens in an encrypted, host-only cookie.
4. `@herkules/oauth-client` verifies the access token through the app's existing `ResourceAuth` and exposes the same `Principal` used for bearer requests.

Browser sessions are stateless in the app. Rotating its cookie secret signs all browsers out. The auth service still owns grant revocation, disabled users, and role changes.

## Remote MCP flow

1. A resource server returns 401 with the exact protected-resource metadata URL in `WWW-Authenticate`.
2. The client fetches that document and discovers the issuer.
3. The client registers through DCR, then completes authorization code with PKCE and consent for the requested resource.
4. The issuer returns a 15-minute, EdDSA-signed token whose `aud` names that resource.
5. The resource server verifies the token against JWKS without calling auth on every request.

CIMD remains unadvertised because the current callback matcher rejects Claude Code's `localhost` port variation. DCR is the supported dynamic path.

## Admission and revocation

Admission comes from an environment-seeded administrator, the checked database allowlist, or membership in the configured GitHub organization. Disabled users are always refused first. The gate runs at login and is rechecked during grants under the TTL and stale-org policy in `services/auth/src/config.ts` and `services/auth/src/gate.ts`.

Access tokens remain valid until expiry. Disabling a user also removes sessions and OAuth refresh tokens. Services that call user-info with the caller's token get an earlier disabled-user check; fully local authorization accepts the remaining short access-token lifetime by design.

All role, allowlist, disable, session, and client changes go through audited transactions. The Better Auth admin endpoints that would bypass this rule are disabled in `services/auth/src/auth.ts`.

## Adding a resource

Add the reviewed resource entry in `services/auth/src/registry.ts`, configure the resource server with the derived public audience and issuer, use `@herkules/auth-middleware` or implement [`tokens.md`](tokens.md), and add the deployment route described by [`../tools/deploy/README.md`](../tools/deploy/README.md). The resource server must not serve a second protected-resource metadata document.
