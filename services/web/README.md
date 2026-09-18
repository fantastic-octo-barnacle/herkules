# Platform web app

`@herkules/web` is the static React app at `https://herkules.dev/`. It provides the public landing page, Feishu and GitHub sign-in, optional identity linking, OAuth consent, connected-client settings, the developer-token flow, and the member administration pages. It has no server state and calls `services/auth` under `/auth` on the same origin.

## Run and test

```sh
vp run dev
vp test
vp check
vp run build
vp run preview
```

The development server runs on `http://localhost:3000` and proxies auth, metadata, and local MCP routes. Copy `.env.example` only when overriding the proxy targets. Production serves the built files through Caddy; see [`../../tools/deploy/README.md`](https://github.com/fantastic-octo-barnacle/herkules-infra/blob/main/tools/deploy/README.md).

## Decisions that bind

- The browser's origin is the public platform origin. There is no build-time API base URL and no cross-origin session setup.
- `src/api.ts` owns calls to Better Auth and `/auth/api/*`. Pages do not construct auth URLs or reinterpret service errors.
- `src/oauth-query.ts` owns Better Auth's signed browser continuation. It reads the address bar directly, preserves repeated signed fields, and removes page-only fields before login or consent posts it. Router search serialization must not touch this protocol message.
- The developer-token page runs a real authorization-code and PKCE flow through the `herkules-web` client. It requests `offline_access` so the token keeps a single resource audience; the issuer refuses refresh for this public client.
- `/` is public and works without a session; it is the only screen that does. Two pathless layouts stack in `src/routes.tsx`: `app` owns the shell that the landing page and every signed-in screen share, and `authed` sits inside it and owns the guard. A wrong address is public too.
- Guards are routing, not rendering: the `authed` layout's `beforeLoad` settles the one session query and redirects to `/login?next=<here>` when nobody is signed in; the `/admin` layout renders a plain refusal for non-admins. `src/session.tsx` owns the session query and safe `next` handling. Admin mutations remain server-enforced and audited.
- Every mutation the person doing it cannot undo goes through `src/confirm.tsx`. The browser's `confirm`, `prompt` and `alert` are not used; a lint-visible grep for them should stay empty.
- The blur on a gated service card is a signpost, not a boundary. The gate is the target's own sign-in — `ops.herkules.dev` is Beszel's herkules-OIDC login, which any member passes.
- Service hostnames are subdomains of whatever origin the browser is on (`src/services.ts`), so the bundle carries no hostname and a deploy to another domain needs no rebuild — the same rule `src/api.ts` follows.
- The app downloads no fonts. Tokens and primitives come from `@herkules/ui` (see `docs/FRAME-ui.md`); `src/main.tsx` imports its theme; `src/layout.tsx` is the page furniture.

## Code map

- `src/main.tsx`: bootstrap — query client, router, providers
- `src/routes.tsx`: the route table and the access guards
- `src/shell.tsx`: header, nav, and the page column every signed-in screen sits in
- `src/api.ts`: typed auth-service client
- `src/oauth-query.ts`: Better Auth signed-query adapter for login and consent
- `src/session.tsx`: the session query, `useSession`, safe `next` handling
- `src/devtoken.ts`: PKCE and token display helpers
- `src/services.ts`: the services the landing page lists, and the origin-relative host derivation
- `src/confirm.tsx`: the one confirmation dialog, used by every destructive action
- `src/pages/`: route-level UI, including the public `Home` and the admin-gated members, allowlist, and audit pages
- `public/hero.webp`: the landing-page photograph. John Cobb, <https://unsplash.com/photos/6btEyS3AJrI>, Unsplash License; cropped to 1920x640, desaturated, WebP q74
- `tests/flow.test.ts`: real auth-service integration through PGlite

## Identity connections

`/auth/login-options` advertises Feishu only when auth has its full configuration.
`/connect-github` offers Connect / Skip after Feishu login; the OAuth provider's
post-login hook uses the same page for signed MCP/OIDC continuations. Completing
the choice persists an onboarding preference before `/oauth2/continue`, so Skip
cannot loop back to the prompt. `oauth-query.ts` preserves the signed parameters
across GitHub linking. Settings connects Feishu to existing GitHub accounts without
changing their user ID, or connects optional GitHub to a Feishu account. The admin
allowlist page includes a separate tenant-key/open-ID form for external Feishu users.

When a connection proves an identity belongs to another account, `identity-merge.tsx`
shows the two identities and the retained account before the shared confirmation
dialog. Confirmation retires the unused duplicate and requires a new sign-in;
Cancel keeps both accounts. Signed OAuth continuation parameters survive the
merge and reauthentication. Expired proofs, conflicting provider identities,
and accounts that both have application history show actionable refusals.
