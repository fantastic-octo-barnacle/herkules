# Application image contract

The root Dockerfile publishes `auth`, `bbs`, `ai` and `platform`. After all checks
pass, CI builds all four in one shared BuildKit graph when image inputs change
(or on a manual run), then emits the `application` artifact.
Production promotion is a separate reviewed change in `herkules-infra`.

`platform` is an artifact-only image: `/srv` contains the built frontend and `/caddy`
contains `platform.caddy`, `bbs.caddy`, `ai.caddy`, and nested `mcp/*.caddy`.
Do not start it as a container. Infrastructure copies these paths into its own Caddy
image and imports the fragments inside the corresponding site blocks. Hostnames,
TLS, global options and common headers belong to infrastructure. Preserve these paths
as a versioned interface; coordinate an incompatible change before promotion.

`sh tools/images/caddy.test.sh` checks the actual fragments using the Caddy parser.
`vp run test:images` checks image-selection rules. Browser API response validation
remains covered by `services/web` tests; static-delivery tests belong to infrastructure.

Documentation-only changes still run checks, but skip image publication.
