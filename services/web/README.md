# Platform web app

`@herkules/web` is the static React app at `https://herkules.dev/`. It provides GitHub sign-in, OAuth consent, connected-client settings, the developer-token flow, and the member administration pages. It has no server state and calls `services/auth` under `/auth` on the same origin.

## Run and test

```sh
vp run dev
vp test
vp check
vp run build
vp run preview
```

The development server runs on `http://localhost:3000` and proxies auth, metadata, and local MCP routes. Copy `.env.example` only when overriding the proxy targets. Production serves the built files through Caddy; see [`../../tools/deploy/README.md`](../../tools/deploy/README.md).

## Decisions that bind

- The browser's origin is the public platform origin. There is no build-time API base URL and no cross-origin session setup.
- `src/api.ts` owns calls to Better Auth and `/auth/api/*`. Pages do not construct auth URLs or reinterpret service errors.
- Consent posts the signed query from Better Auth. It fetches client and resource display names from the auth service and does not trust unsigned URL fields as authority.
- The developer-token page runs a real authorization-code and PKCE flow through the `herkules-web` client. It requests `offline_access` so the token keeps a single resource audience; the issuer refuses refresh for this public client.
- Guards are routing, not rendering: the `authed` layout's `beforeLoad` in `src/routes.tsx` settles the one session query and redirects to `/login?next=<here>` when nobody is signed in; the `/admin` layout renders a plain refusal for non-admins. `src/session.tsx` owns the session query and safe `next` handling. Admin mutations remain server-enforced and audited.
- The app downloads no fonts. Tokens and primitives come from `@herkules/ui` (see `docs/FRAME-ui.md`); `src/main.tsx` imports its theme; `src/layout.tsx` is the page furniture.

## Code map

- `src/main.tsx`: bootstrap — query client, router, providers
- `src/routes.tsx`: the route table and the access guards
- `src/shell.tsx`: header, nav, and the page column every signed-in screen sits in
- `src/api.ts`: typed auth-service client
- `src/session.tsx`: the session query, `useSession`, safe `next` handling
- `src/devtoken.ts`: PKCE and token display helpers
- `src/pages/`: route-level UI, including the admin-gated members, allowlist, and audit pages
- `tests/flow.test.ts`: real auth-service integration through PGlite
