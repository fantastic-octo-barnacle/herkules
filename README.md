# Herkules

Herkules is the team's self-hosted identity layer and internal application monorepo. The platform runs on one origin for authorization and MCP resources, while products such as RM 文库 use their own subdomains and the same issuer.

## Repository map

| Workspace                                                        | Purpose                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`services/auth`](services/auth/README.md)                       | Better Auth authorization server, resource registry, users, roles, gate, and audit |
| [`services/web`](services/web/README.md)                         | Platform login, consent, settings, admin, and developer-token SPA                  |
| [`services/mcp-directory`](services/mcp-directory/README.md)     | Stateless MCP server that tests the complete authorization path                    |
| [`apps/bbs`](apps/bbs/README.md)                                 | RM 文库 API, MCP server, SPA host, corpus, search, and crawler                     |
| [`packages/auth-middleware`](packages/auth-middleware/README.md) | Resource-server JWT verification and OAuth challenge helpers                       |
| [`packages/oauth-client`](packages/oauth-client/README.md)       | Stateless first-party browser OAuth sessions for Hono apps                         |
| [`packages/utils`](packages/utils/README.md)                     | Small shared utilities                                                             |
| [`tools/deploy`](tools/deploy/README.md)                         | Production and local-stack runbook                                                 |

Cross-cutting contracts live in [`docs`](docs/README.md):

- [`docs/auth.md`](docs/auth.md) maps identity, ownership, and request flows.
- [`docs/tokens.md`](docs/tokens.md) is the language-neutral resource-server contract.
- [`docs/deploy.md`](docs/deploy.md) points to the operational runbook.

## Development

The repository uses Vite+. Run commands through the direnv environment on nix-darwin if `vp` is not already on `PATH`.

```sh
direnv exec . vp install
direnv exec . vp run ready
```

Common commands:

```sh
vp run dev       # platform web development task
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
