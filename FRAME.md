# Frame: herkules auth layer — 2026-08-28

## Problem

A small team (Hong Kong, Singapore, some mainland China; some members without a
proxy) needs one identity for its internal tools. Two kinds of client must
authenticate: people in a browser, and AI coding clients (Claude Code, VS Code /
Copilot) reaching internal MCP servers over HTTP. Services need a stable user ID
for per-user storage and an admin/member role. Everything must run on one
2 vCPU / 4 GB VPS in Hong Kong, with the database movable to another host or a
SaaS by changing a connection string.

## Prior art

- **`../herkules-old/apps/auth`** — a Better Auth 1.7 issuer at
  `auth.herkules.dev` with `oauth-provider`, `mcp`, `cimd`, `api-key`, `jwt`,
  `organization`; GitHub provider; roles resolved admin-list → per-app
  allowlist → GitHub org membership. Built 2026-08-28 inside a TanStack Start +
  Nitro monorepo that also carries the rm-wenku Rust crates verbatim, PGroonga +
  pgvector Postgres, and a 10-phase roadmap. **Ported, not extended.** It was
  built too quickly and several design choices were poor; this repo rebuilds
  each component deliberately. The auth plugin wiring and role-resolution logic
  are reused as reference; the surrounding shape is not.
- **`../rm-wenku`** — hand-rolled GitHub OAuth in Rust/axum, opaque session
  cookies, `rmk_` personal access tokens, `rmcp` MCP with optional bearer,
  admin/member roles, `AUTH_OPEN_SIGNUP` gate, no org gate. Full
  compose/Caddy/GHCR/Gatus/Beszel deployment. **Ignored for auth code** (no
  OAuth server, no org gate, no cross-service tokens); **reused as the
  deployment pattern**. It runs on a separate server and will later become an
  OIDC client and a resource server of this auth service.
- **`../herkules-web-archive`** — DeepSeek proxy with hashed API keys and
  GitHub admin sessions. Ignored.
- **`~/dev/projects/games/chesseval/crates/mcp`** — a Rust MCP server. Pattern
  reference for a future Rust resource server only.
- **Ecosystem** — Better Auth (chosen); Logto (official Feishu connector and
  MCP auth, but CIMD-only, no RFC 7591 DCR, and 8 GiB recommended); Clerk (no
  Feishu, US edge unreliable from mainland, identity data off-site); Keycloak /
  Authentik / Zitadel (footprint far above what a 4 GB box shared with services
  allows).

## Decision

**Self-hosted Better Auth 1.7 as an OAuth 2.1 / OIDC authorization server,
issuing JWTs that every service verifies locally via JWKS.**

Topology: one HK VPS, Caddy (DNS-only, Caddy-managed TLS), Docker Compose, one
container per service. Single origin `herkules.dev`, path-routed:

| Path                        | Service                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `/`                         | `services/web` — Vite React SPA: login, consent, settings, admin, dev-token page |
| `/auth/*`, `/.well-known/*` | `services/auth` — Hono + Better Auth                                             |
| `/mcp/<name>`               | that MCP server's container                                                      |

Distinct products (the BBS) stay on their own subdomains and join later by
adding a Caddy snippet. Issuer is `https://herkules.dev/auth`.

Auth service:

- Hono + Better Auth 1.7 with `oauthProvider`, `mcp`, `jwt`, `admin` plugins;
  Drizzle; Postgres via `DATABASE_URL`.
- Login: GitHub only. Gate in `user.validateUserInfo`: member of the controlled
  GitHub org (`read:org`) **or** present in the allowlist table; re-checked on
  every refresh.
- Roles: `admin` / `member`. First admin from `ADMIN_GITHUB_LOGINS`.
- Tokens: JWT access tokens (15 min) with claims `sub` (opaque user id), `aud`,
  `role`, `exp`; refresh tokens 30 d rotating; web session 30 d. One audience
  per resource; consent per client per resource.
- Clients: DCR enabled (Claude Code requires it today) and CIMD enabled (the
  MCP 2026-07-28 path); consent screen always shown; redirect-URI allowlist
  (`localhost`, `127.0.0.1`, `vscode://`, claude.ai callback); users and admins
  can view and revoke connected clients.
- Resource registry: static config mapping `name → URL → audience`; the auth
  service serves every `/.well-known/oauth-protected-resource/mcp/<name>`.
- User-info API: `GET /auth/api/users/:id` and a batch form, returning
  `{ id, displayName, avatarUrl, githubId }`; any member JWT is accepted.
  Display name mirrored from GitHub on each login; avatars cached to a volume
  and served from `herkules.dev`.
- Audit table (append-only): logins, gate rejections with reason, token
  issuance per client, consent grants, admin actions. Plain list in admin UI.
- Built-in rate limiting; `/healthz` on every service.

Resource-server contract (`docs/tokens.md`, language-neutral): verify the JWT's
signature, issuer, `aud`, and `exp` against `https://herkules.dev/auth/jwks`;
on failure respond `401` with
`WWW-Authenticate: Bearer resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/mcp/<name>"`.
`packages/auth-middleware` is the TypeScript convenience. Non-TypeScript
servers live in their own repos; this repo's compose pulls their images by tag.

Self-test MCP: `services/mcp-directory`, its own container and audience
(`mcp/directory`), verifies via `packages/auth-middleware`, tools `whoami`,
`list_members`, `get_member` backed by the user-info API. It exercises PRM
discovery, consent, cross-process JWKS verification, audience binding, and the
user-info API in one flow.

Dev and deploy: two GitHub OAuth apps (dev, prod). Local compose (Postgres +
auth + web); a dev-token page mints 15-minute JWTs for a chosen audience for
curl. GitHub Actions → GHCR → SSH `docker compose pull && up -d`. Nightly
`pg_dump` to Cloudflare R2. `.env` on the box, `.env.example` checked in.
Workspace: `services/*`, `packages/*`, `tools/deploy`; the `apps/website`
scaffold is replaced.

Alternatives considered:

- **Clerk / hosted SaaS** — lost on Feishu absence, mainland reachability, and
  identity data living off-site; roles would still be ours to build.
- **Logto** — lost on RAM (8 GiB recommended) and no RFC 7591 DCR, which
  Claude Code needs today.
- **Hand-rolled (rm-wenku style)** — lost because an OAuth 2.1 AS with PKCE,
  DCR/CIMD, consent, refresh rotation, and metadata endpoints is exactly the
  code you do not want to write by hand for a small team.
- **Opaque tokens + introspection** — lost to JWT+JWKS: instant revocation is
  not worth putting the auth service on every request's critical path across
  containers; 15-minute access tokens bound the lag.
- **Caddy `forward_auth`** — lost: services would work only behind this Caddy
  and Python/Rust servers still need the 401 challenge logic.
- **Subdomain issuer (`auth.herkules.dev`)** — lost: cross-origin SPA, CORS,
  `Domain=.herkules.dev` cookie reaching every subdomain; the `.well-known`
  proxy route is needed either way for resource metadata.
- **One process / one container** — lost to the user's decision for separate
  containers; JWT+JWKS makes that split cheap.

## In scope

- `services/auth`: Better Auth issuer, GitHub gate, roles, tokens, registry,
  user-info API, avatars, audit, JWKS.
- `services/web`: login, consent, settings (connected clients, revoke), admin
  (users, roles, allowlist, disable, sessions, audit list), dev-token page.
- `services/mcp-directory`: the self-test MCP server.
- `packages/auth-middleware`: TS JWT verifier and 401 challenge helper.
- `docs/tokens.md`: the cross-language contract.
- `tools/deploy`: compose (Caddy, auth, web, mcp-directory, Postgres, backup
  cron), Caddy snippets per service, GitHub Actions to GHCR, SSH deploy.
- Local dev compose and two OAuth apps.

## Out of scope

- Feishu login and Feishu account linking.
- Lark MCP proxy (`lark-openapi-mcp`); when it comes: single app credential,
  curated tool list, one audience per upstream, credential resolved through
  `getUpstreamCredential(userId, upstream)` so per-user tokens can slot in.
- Website AI chat (when it comes: first-party token exchange, not consent).
- Personal access tokens / headless clients.
- Scopes within a resource.
- Machine-to-machine (`client_credentials`) tokens.
- BBS (rm-wenku) integration — designed for (standard OIDC provider, opaque
  `sub` as join key, no user migration needed), not built. _Amended
  2026-08-28: the BBS is ported into this monorepo as `apps/bbs` on
  `bbs.herkules.dev`, a first-party confidential client; see
  `apps/bbs/FRAME.md`._
- Gatus / Beszel overlay; Sentry; any analytics.
- sops / agenix secrets; staging environment.
- Admin-editable resource registry; user-editable display name or avatar.
- Email or password login.

## Kill criterion

If `@better-auth/mcp` cannot issue tokens for multiple remote resource servers
with distinct audiences behind one issuer without patching the library, **or**
if Claude Code and VS Code cannot both complete the OAuth flow against it within
the first week of integration, stop: the authorization-server choice is wrong.
Re-frame between Logto (CIMD-only) and a hand-rolled AS on `oauthProvider`
primitives. Do not quietly rewrite around it.

## Done predicate

1. `claude mcp add --transport http directory https://herkules.dev/mcp/directory`,
   then `/mcp` → GitHub login → consent → `whoami` returns the caller. The same
   flow completes in VS Code.
2. A GitHub user outside the org and not on the allowlist is rejected at login,
   and an audit row records who and why.
3. A ~30-line Python script written only from `docs/tokens.md` accepts a valid
   `mcp/directory` token via JWKS, and rejects both a token for another audience
   and an expired one.
4. On the admin page: promote/demote, disable, revoke sessions, edit allowlist —
   each action appears in the audit log.
5. `docker compose pull && up -d` on the HK VPS from a GHCR image built by
   Actions brings the stack up, and a nightly dump lands in R2.

## Verification done before build (2026-08-28)

Read from `@better-auth/mcp` and `@better-auth/oauth-provider` source on `main`:

- Multiple resources are first-class: `resources: [...]` seeds `oauthResource`
  rows (`resourceSeedMode: "overwrite"` makes config the single source of
  truth); a client's `resource` request becomes the JWT `aud`; per-resource
  `allowedScopes`, `accessTokenTtl`, `customClaims`, DPoP.
- `enforcePerClientResources` defaults to `true`: a client may only request
  resources it is _linked_ to, and DCR/CIMD clients are linked only to
  `clientRegistrationDefaultResources` (+ the canonical MCP resource) at
  registration. Adding a registry entry later would leave existing IDE clients
  unlinked (`invalid_target`). **Decision: `enforcePerClientResources: false`.**
  All clients are the team's own IDE clients, consent is still per resource,
  and tokens are still audience-bound.
- `mcp()` serves protected-resource metadata for its single canonical
  `resource` only. Every other resource's `401` challenge points at
  `https://herkules.dev/.well-known/oauth-protected-resource/mcp/<name>`, which
  nothing serves by default. **Decision: the auth service serves every PRM
  document from the registry** (a small route ahead of the Better Auth
  handler, using the exported `metadataResponse`/`getIssuer`; document shape
  `{ resource, authorization_servers, bearer_methods_supported,
dpop_signing_alg_values_supported, scopes_supported? }`). Canonical
  `resource` is `https://herkules.dev/mcp/directory`.
- Path-based issuer works: metadata derives from `baseURL`
  (`https://herkules.dev/auth`); AS metadata is served at
  `{issuer}/.well-known/…` and at the root path-inserted alias
  `/.well-known/oauth-authorization-server/auth`; exportable root handlers
  exist. Caddy routes `/.well-known/*` to the auth container.
- Remaining unverified: that Claude Code and VS Code try the path-inserted AS
  metadata URL for an issuer with a path (spec-mandated since 2025-06-18).
  Covered by done-predicate check 1; still part of the kill criterion.

## Status — 2026-08-28

v1 code complete: five deliverables, one commit each (`661e176` auth +
middleware + contract, `d73712b` mcp-directory, `b07ad7d` web, `581c5df`
deploy). Design records: each package's `DESIGN.md`, `tools/deploy/README.md`.

Done predicate:

| #   | check                                                               | state                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Claude Code + VS Code: add → login → consent → whoami               | **Claude Code passed** against the local stack (`http://localhost:3000`). VS Code and the deployed origin pending. |
| 2   | Non-member refused at login, audited                                | Proven by `services/auth/tests/flow.test.ts` (fake GitHub). Real second account not yet tried.                     |
| 3   | ~30-line Python verifier from `docs/tokens.md`                      | **Passed** — `docs/verify_token.py`, 16/16 vectors, and against tokens the real service minted.                    |
| 4   | Admin actions each audited                                          | **Passed** — API in tests; pages used locally (members, allowlist, audit, disconnect).                             |
| 5   | GHCR image → `compose pull && up -d` on the box, nightly dump in R2 | Pending: prod OAuth app, `.env` on the box, repo secrets, first push. Stack verified locally on Postgres.          |

Decision amendment: **CIMD is not advertised.** Better Auth's redirect matcher
grants RFC 8252 port variance to loopback IPs only; Claude Code's metadata
document registers `http://localhost/callback` and requests a random port, so
every CIMD authorize failed. Claude Code falls back to DCR, which works. Not
the kill criterion (no library patch); revisit when the matcher accepts
`localhost`.

Kill criterion: not fired. Remains open only for VS Code and the path-inserted
metadata URL on the real origin.

New features get their own frame at the feature root (e.g.
`services/mcp-lark/FRAME.md`); this file stays the auth layer's record.
