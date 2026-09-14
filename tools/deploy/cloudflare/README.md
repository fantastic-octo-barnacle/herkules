# Cloudflare static assets experiment

Two asset-only Workers test offloading the platform SPA and BBS hashed JS/CSS on
Workers Free. There is no application Worker handler, database binding, ACM,
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
vp run dev:edge:bbs       # http://localhost:8788/assets/<built filename>
```

Run the two dev commands in separate terminals. `test:edge` starts its own local
Wrangler processes on ports 18787/18788 and stops them afterwards. It checks SPA
deep links, the AI redirect, response headers, byte-for-byte JS/CSS delivery,
and that the BBS upload exposes neither API/document routes nor server bundles.

The standalone platform preview shows the frontend shell only: it has no auth or
API backend. Sign-in and authenticated screens must be tested through the normal
Vite stack, or after same-origin production routing is attached. Never configure
OAuth callbacks against the experiment's workers.dev address.

`prepare.mjs` stages public files under ignored `dist/`: the platform build, and
only BBS's `dist/client/assets/`. It enforces Workers Free file-size/count limits.
The platform gets SPA fallback; BBS deliberately returns 404 for missing files
and has no SPA fallback. Headers preserve security policy and immutable hashed
assets; platform documents revalidate. `X-Herkules-Delivery` identifies edge assets.

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
Record the returned URLs and version IDs. No GitHub workflow deploys these Workers.

## Production experiment routing

Standalone previews do not yet offload live traffic. Before attaching routes,
inventory existing Cloudflare routes and preserve them. Keep the proxied origin
DNS records in place; use Workers Routes, not Custom Domains.

The intended routing is:

| Pattern                             | Destination                |
| ----------------------------------- | -------------------------- |
| `herkules.dev/*`                    | platform asset Worker      |
| `herkules.dev/auth*`                | no Worker; existing origin |
| `herkules.dev/.well-known*`         | no Worker; existing origin |
| `herkules.dev/mcp*`                 | no Worker; existing origin |
| `bbs.herkules.dev/assets/*`         | BBS asset Worker           |
| Other BBS paths and other hostnames | existing origin            |

Install the no-Worker exceptions before the platform catch-all. These deliberately
broad exceptions cover bare prefixes, descendants and query strings. They retain
the origin's `/auth/internal/*` block. The platform `/ai` redirect is included in
the uploaded `_redirects` file. Other domains require regenerating that redirect.
Do not add a catch-all on BBS: its origin injects article/link-preview metadata.
Do not enable `run_worker_first` or Workers Caching for this experiment: direct
asset serving is free and unlimited; Worker execution has a separate daily quota.

Attach live routes only using assets matching the active production frontend
versions. BBS HTML still references the origin build's hashed filenames. A later
BBS release can reference assets missing from this experiment; remove its route
before the next production deployment unless assets from both releases are staged
and verified first. Likewise, detach the platform route before a backend release
that changes the frontend contract. This experiment is not integrated into the
OCI release/rollback system yet and must not silently outlive those releases.

After activation, verify platform `/`, deep links, real sign-in, OAuth discovery,
MCP challenges, BBS article preview metadata, and every asset URL referenced by
the live BBS document. Compare the delivery header, Cloudflare request metrics,
and VPS traffic. Local tests cannot validate Cloudflare zone route precedence.

Rollback: remove only the two experiment Worker routes (platform catch-all and
BBS assets), preserving pre-existing routes and DNS. Requests return to Caddy/BBS,
which still contain the original assets. Remove experiment-only bypass entries
afterwards if no longer needed. Do this before deleting the Workers. Rerunning
the preview deploy configurations, which specify empty routes, also must not be
used as an update mechanism for an activated production experiment.

References: [asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
[route exclusions](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[SPA serving](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).
