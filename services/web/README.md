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
- `src/session.tsx` owns the one session load, safe return paths, and admin routing. Admin mutations remain server-enforced and audited.
- The app downloads no fonts and uses no motion. Color and typography tokens live in `src/styles.css`.

## Code map

- `src/main.tsx`: routes and access boundaries
- `src/api.ts`: typed auth-service client
- `src/session.tsx`: session and route guards
- `src/devtoken.ts`: PKCE and token display helpers
- `src/pages/`: route-level UI
- `tests/flow.test.ts`: real auth-service integration through PGlite
