# Cross-cutting documentation

- [`auth.md`](auth.md) describes identity, ownership, and request flows across services.
- [`tokens.md`](tokens.md) is the versioned, language-neutral access-token and resource-server contract.
- [`tokens-vectors.json`](tokens-vectors.json) contains conformance vectors for that contract.
- [`verify_token.py`](verify_token.py) is the reference verifier used by the vectors.
- [`deploy.md`](deploy.md) points to the production and local-stack runbook.
- [`FRAME-ui.md`](FRAME-ui.md) is the decision record for the shared `@herkules/ui` layer: Tailwind v4 + shadcn, and the TanStack Router verdict.

Component-specific operation and binding decisions belong in that component's README.
