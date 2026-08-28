# Herkules

Herkules is the team's self-hosted identity layer and internal application monorepo. The platform runs on one origin for authorization and MCP resources, while products such as RM 文库 use their own subdomains and the same issuer.

## Repository map

| Workspace                                                        | Purpose                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`services/auth`](services/auth/README.md)                       | Better Auth authorization server, resource registry, users, roles, gate, and audit |
| [`services/web`](services/web/README.md)                         | Platform login, consent, settings, admin, and developer-token SPA                  |
| [`apps/bbs`](apps/bbs/README.md)                                 | RM 文库 API, MCP server, SPA host, corpus, search, and crawler                     |
| [`packages/auth-middleware`](packages/auth-middleware/README.md) | Resource-server JWT verification and OAuth challenge helpers                       |
| [`packages/oauth-client`](packages/oauth-client/README.md)       | Stateless first-party browser OAuth sessions for Hono apps                         |
| [`tools/deploy`](tools/deploy/README.md)                         | Production and local-stack runbook                                                 |

Cross-cutting contracts — identity flows, the resource-server token contract, the deploy runbook pointer, and UI decision records — are indexed in [`docs/README.md`](docs/README.md).

## Development

The repository uses Vite+. Install the global `vp` CLI once; it manages Node and pnpm itself, per the root `package.json` `devEngines`.

```sh
curl -fsSL https://vite.plus | bash
vp install
vp run ready
```

Common commands:

```sh
vp run dev       # the whole local stack: auth :3001, web :3000, bbs :3103 + :3003
vp check         # format, lint, and type-check the workspace
vp test          # run tests from the current workspace
vp run -r test   # run package test scripts recursively
vp run -r build  # build every workspace
```

Check a workspace's README and `package.json` before running it. `vp <name>` invokes a Vite+ built-in; `vp run <name>` invokes a package script or task.

## System boundaries

- `services/auth/src/registry.ts` owns public resource identifiers and token audiences.
- [`docs/tokens.md`](docs/tokens.md) owns the verification and challenge contract across languages.
- Each app or service owns its database and application policy. Identity joins use the issuer's opaque `sub` only.
- [`tools/deploy/README.md`](tools/deploy/README.md) owns operational commands. Component READMEs link there instead of duplicating the runbook.
