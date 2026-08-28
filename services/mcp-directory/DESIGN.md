# services/mcp-directory — design

The self-test MCP server FRAME names: its own container and audience
(`https://herkules.dev/mcp/directory`), tokens verified by
`@herkules/auth-middleware`, names resolved through the auth service's
user-info API. It exists to exercise PRM discovery, consent, cross-process JWKS
verification, audience binding and the user-info API in one flow — the
done-predicate-1 path. It has no state of its own.

## Usage (caller's view)

```
claude mcp add --transport http directory https://herkules.dev/mcp/directory
/mcp  → 401 Bearer resource_metadata=… → GitHub login → consent → token
> whoami          { id, displayName, avatarUrl, githubId, role, clientId, resource, tokenExpiresAt }
> list_members    { members: [{ id, displayName, avatarUrl, githubId }] }
> get_member(id)  one member, or a tool error "No member with id …"
```

## Shape

| module            | owns                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`   | `PUBLIC_ORIGIN` → `resource` (`…/mcp/directory`) and `issuer` (`…/auth`); `AUTH_INTERNAL_URL` for in-network calls (JWKS, user-info); `PORT` 3002         |
| `src/userinfo.ts` | Typed client for `/auth/api/users`, `/users/:id`, `/me`. Forwards the **caller's** token; throws `UserInfoError(status, code)`                            |
| `src/tools.ts`    | `createDirectoryServer(principal, deps)`: a fresh `McpServer` per request with the three tools closed over the verified principal                         |
| `src/app.ts`      | Hono: open `/mcp/directory/healthz`; `GET/POST/DELETE /mcp/directory` behind `honoAuth(mcpResource)` → SDK `createMcpHandler(...).fetch(req, {authInfo})` |
| `src/main.ts`     | `createService({ env, fetch })` (the `fetch` seam serves both JWKS and user-info in tests) and `main()` on `@hono/node-server`                            |

## Decisions

- **MCP SDK 2.0 (`@modelcontextprotocol/server`), `createMcpHandler`.** One
  factory serves the 2026-07-28 revision and the stateless 2025 path that
  Claude Code and VS Code speak today. The factory receives `authInfo`, so the
  principal is rebuilt once (`principalOf`) and the tools close over it: no
  handler ever digs through `ctx.http`. Stateless: GET/DELETE session
  operations answer 405 on the legacy path, which is what a stateless server
  should say.
- **No credential of its own.** Every user-info call carries the caller's
  token (services/auth accepts any registry audience there). A disabled user
  holding a still-live JWT therefore gets `whoami` from the token alone but a
  `403 account_disabled` tool error from `list_members` — the user-info API is
  where the JWT revocation gap closes, and this server inherits that.
- **`whoami` degrades, the others fail.** With the auth service unreachable,
  `whoami` answers from the principal (no display name); `list_members` and
  `get_member` return `isError` tool results (`user-info API: unavailable: …`),
  never a protocol error, so the IDE keeps its session.
- **Auth-service change made for this service:** `GET /auth/api/users` — the
  member directory (every non-disabled user, sorted by name, bounded at 500),
  callable by any identified member. The admin list stays admin-only.
- **Host/Origin validation is Caddy's.** The SDK's DNS-rebinding helpers are
  not wired: the container is only reachable through the reverse proxy.

## Tests

- `tests/app.test.ts` — middleware test issuer + in-memory user-info:
  challenge strings, wrong audience, expiry, both protocol eras (raw 2025 POST
  and the SDK 2.0 client), JWKS fetched once, degraded mode.
- `tests/e2e.test.ts` — the real auth service (`@herkules/auth/testing`, PGlite,
  fake GitHub): login → DCR → consent → token → `whoami`/`list_members`/
  `get_member` with real names; a `notes`-audience token refused; a disabled
  member's live token refused at the user-info hop.

Not covered until the kill-criterion run: real Claude Code and VS Code against
a deployed origin (the path-inserted AS-metadata URL, native redirect URIs).
