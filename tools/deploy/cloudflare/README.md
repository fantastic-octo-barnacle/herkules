# Cloudflare static asset delivery

Two asset-only Workers offload the platform SPA and BBS ordinary SPA documents
plus public files on Workers Free. BBS API, OAuth, health, MCP, and article/KB
metadata documents remain on the origin through explicit zone route bypasses. There is no application Worker handler, database binding, ACM,
paid subscription, or production route in these configurations. The regular
Docker images retain their frontend files.

## Local development

Continue using `vp run dev` at the repository root. All Vite roots, hot reload,
API proxies and ports are unchanged. Wrangler is only an optional production-like
asset preview; it does not replace the local application stack.

From the repository root:

```sh
vp install
vp run build:edge
vp run test:edge
vp run dev:edge:platform  # http://localhost:8787
vp run dev:edge:bbs       # http://localhost:8788/about (static frontend preview)
```

Run the two dev commands in separate terminals. `test:edge` starts its own local
Wrangler processes on ports 18787/18788 and stops them afterwards. It checks SPA
deep links, the AI redirect, response headers, byte-for-byte JS/CSS delivery,
BBS ordinary documents and public files, and that the BBS upload contains no server bundles.
Route tests separately pin the production origin bypasses and failure recovery.

The standalone platform preview shows the frontend shell only: it has no auth or
API backend. Sign-in and authenticated screens must be tested through the normal
Vite stack, or after same-origin production routing is attached. Never configure
OAuth callbacks against the experiment's workers.dev address.

`prepare.mjs` stages public files under ignored `dist/`: the platform build, and
an allowlist from BBS's `dist/client/`: `index.html`, `assets/`, `favicon.svg`, and
`robots.txt`. It enforces Workers Free file-size/count limits. Both uploads use
SPA fallback. Headers preserve security policy and immutable hashed assets;
documents revalidate and BBS favicon/robots cache for one hour.
`X-Herkules-Delivery` identifies edge responses. The `bbs-assets` directory and
Worker name are retained for compatibility with existing releases.

BBS's standalone preview has **no API or origin bypasses**: API and metadata
paths can return the plain SPA shell, not real data or injected link metadata.
Use `/about` to inspect the frontend without a backend; data-driven screens need
the normal local stack. Never test OAuth against this preview. Production keeps
same-origin API/OAuth URLs and routes them to the existing backend. No database,
authentication, API caching, or crawler behavior changes in this stage.

## Publish standalone previews

Authenticate using `vp exec wrangler login`, or provide scoped
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables. Do not put
credentials in these configurations. Then:

```sh
vp exec wrangler deploy --dry-run --config tools/deploy/cloudflare/platform.json
vp exec wrangler deploy --dry-run --config tools/deploy/cloudflare/bbs-assets.json
vp exec wrangler deploy --config tools/deploy/cloudflare/platform.json
vp exec wrangler deploy --config tools/deploy/cloudflare/bbs-assets.json
```

These publish only the two named experiment Workers on workers.dev, with no
custom domains or zone routes. Public frontend assets are public on these URLs.
Record the returned URLs and version IDs. Production uses separate Worker names;
CI never publishes these experiment Workers.

## CI and production releases

CI builds both frontends, runs local Workers runtime checks and route failure
recovery tests, and dry-runs both Wrangler configurations without credentials.
Ordinary `vp run dev` continues to use Vite and the existing backend proxies.

Enable production delivery in the GitHub `production` environment:

- Variable `CLOUDFLARE_ASSETS_ENABLED=true` (unset leaves the existing VPS flow).
- Variables `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID` for `herkules.dev`.
- Secret `CLOUDFLARE_API_TOKEN`: Workers Scripts Edit for the account and Workers
  Routes Edit for this zone (plus account/zone read permissions if required by
  Wrangler). No R2, billing, DNS-write or Origin CA private-key access is needed.

Keep the existing proxied DNS records and Full (strict) TLS settings. This does
not purchase a subscription or enable ACM. Production uses `herkules-platform`
and `herkules-bbs-assets`, with workers.dev and preview URLs disabled. Do not
manually attach the experiment Workers to production routes.

`images.yml` and `rollback.yml` both run under `deploy-production` concurrency:

1. Verify route ownership and detach the two production asset routes before
   modifying the VPS. Unrelated routes and existing backend bypasses are preserved.
   A Cloudflare API failure here stops the rollout before the origin is changed.
2. Apply the existing immutable OCI release using the existing health checks and
   server-side recovery. While detached, Caddy/BBS serve their own frontend files.
3. Record the successful backend Deployment before attempting edge activation,
   so a Cloudflare failure cannot leave the server and GitHub release cursor apart.
4. Pull the exact `caddy` and `bbs` image digests in that release on the CI runner.
   Copy `/srv` and `/app/dist/client` out of stopped containers; do not run them or
   rebuild assets from the checkout. BBS's allowlisted public client files are uploaded.
5. Upload both asset-only Workers, install backend bypasses, then attach the asset
   routes. Check every uploaded JS/CSS file against its bytes and delivery header,
   platform HTML, auth health, the internal-auth block, OAuth discovery and the MCP
   challenge. Verification retries allow for Cloudflare propagation.
6. On upload/activation/verification failure, detach both asset routes and report
   **origin** delivery with a workflow warning. The healthy backend release stays
   active. If route cleanup cannot be confirmed, fail the workflow for intervention.

There is no atomic transaction across Cloudflare and the VPS. Route propagation
can briefly overlap during a switch; the origin always retains its assets. The
workflow does not claim uninterrupted open-tab asset compatibility across releases.
A failed or cancelled origin rollout leaves delivery on the origin; the next
successful deployment restores edge delivery. A manual Images run retries even
when no source files changed.

The same steps run for full and component rollback, including releases created
before this integration. For component rollback, assets come from the resulting
image tuple: restoring `bbs` restores its frontend; restoring `caddy` restores the
platform frontend. Image digests are the durable frontend source of truth. Workers
are republished from them rather than relying on Cloudflare version retention.
The current deployment tooling supplies headers/routing during old-release rollback.

Each completed edge attempt uploads `edge-delivery.json` as a workflow artifact
with source SHA, both immutable image references and `edge`/`origin` delivery.
It is an operational receipt, not the authoritative backend release cursor.
No separate Worker deploy should run outside the shared production lock.

## Route ownership

| Pattern                      | Destination                                   |
| ---------------------------- | --------------------------------------------- |
| `herkules.dev/*`             | `herkules-platform`                           |
| `herkules.dev/auth*`         | no Worker; origin                             |
| `herkules.dev/.well-known*`  | no Worker; origin                             |
| `herkules.dev/mcp*`          | no Worker; origin                             |
| `bbs.herkules.dev/assets/*`  | `herkules-bbs-assets` (retained legacy route) |
| `bbs.herkules.dev/*`         | `herkules-bbs-assets`                         |
| `bbs.herkules.dev/api*`      | no Worker; origin                             |
| `bbs.herkules.dev/login*`    | no Worker; origin                             |
| `bbs.herkules.dev/callback*` | no Worker; origin                             |
| `bbs.herkules.dev/logout*`   | no Worker; origin                             |
| `bbs.herkules.dev/healthz*`  | no Worker; origin                             |
| `bbs.herkules.dev/mcp*`      | no Worker; origin                             |
| `bbs.herkules.dev/articles*` | no Worker; origin (metadata/404s)             |
| `bbs.herkules.dev/kb*`       | no Worker; origin (metadata/404s)             |
| Other hostnames              | existing origin                               |

Backend exceptions are installed before the platform catch-all. Broad prefixes
cover bare paths, descendants and query strings and preserve `/auth/internal/*`
blocking. BBS article/entity documents retain origin-injected link-preview metadata and missing-ID 404s.
The whole `/kb*` prefix stays at origin deliberately (including the `/kb` browse
shell); `/`, `/search`, `/tags`, `/status`, `/about`, and `/account` now load their
shell from the edge. Data still needs the VPS. The asset-only catch-all mirrors
the existing generic SPA fallback for other paths. The platform
`/ai` redirect still targets `https://ai-portal.herkules.dev`. This deployment
configuration is intentionally specific to `herkules.dev`.

An exact managed pattern belonging to another Worker is a conflict and stops the
operation. Before first activation, audit overlapping wildcard/more-specific routes,
redirect/cache rules and custom domains in the dashboard; this script does not
rewrite them. Future Terraform must not also own these managed route resources or
Worker uploads. It can own DNS, Cloudflare Access, and unrelated zone configuration
separately.

## Disable and recovery

To disable edge delivery, first run (with the same scoped credentials):

```sh
CLOUDFLARE_ASSETS_ENABLED=true node tools/deploy/cloudflare/release.mjs detach
```

Then unset `CLOUDFLARE_ASSETS_ENABLED` in GitHub. Do not simply remove credentials
or unset the flag while routes are attached: that would leave old Workers serving
across future releases. Manual route removal in the dashboard is the recovery if
API credentials are unavailable: remove only the two production Worker routes,
not DNS or other applications' routes. The no-Worker bypasses may remain.

If a workflow fails after backend success, inspect the edge receipt/logs. Do not
roll back the database or edit the VPS release marker to repair an edge failure.
Detach routes if cleanup failed, then rerun Images or the desired rollback.

References: [asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
[route exclusions](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[SPA serving](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).
