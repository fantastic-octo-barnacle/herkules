# MCP directory

`@herkules/mcp-directory` is the stateless self-test MCP server at `https://herkules.dev/mcp/directory`. It verifies the directory audience, exposes `whoami`, `list_members`, and `get_member`, and resolves display data through the auth service's user-info API.

The service exercises the complete remote-MCP login path: protected-resource discovery, authorization, consent, JWKS verification, audience binding, and user-info.

## Run and test

Copy `.env.example` to `.env` when running it outside the root development task.

```sh
vp run dev
vp test
vp check
vp run build
```

For an installed client:

```sh
claude mcp add --transport http directory https://herkules.dev/mcp/directory
```

## Decisions that bind

- The resource name is `directory`; `src/config.ts` derives the exact audience and issuer from `PUBLIC_ORIGIN`. `AUTH_INTERNAL_URL` changes only how this process reaches auth, never public identifiers.
- `@herkules/auth-middleware` owns verification and challenges. A fresh MCP server closes over the verified principal for each request; tools do not inspect transport internals.
- Every user-info call forwards the caller's token. The service has no service credential and no user database.
- `whoami` can answer from token claims when user-info is unavailable. Directory lookups return MCP tool errors so the protocol session survives.
- The server is stateless. Legacy GET and DELETE session operations return 405.
- Caddy owns host and origin validation because the container is not exposed directly.

## Code map

- `src/config.ts`: public identity and internal auth address
- `src/app.ts`: Hono, auth middleware, transport, and health route
- `src/tools.ts`: server metadata and three tools
- `tests/app.test.ts`: protocol versions, challenges, cache, degraded behavior
- `tests/e2e.test.ts`: real issuer, audience rejection, and disabled-user behavior
