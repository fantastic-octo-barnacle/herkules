# Cross-cutting documentation

- [`auth.md`](auth.md) describes identity, ownership, and request flows across services.
- [`tokens.md`](tokens.md) is the versioned, language-neutral access-token and resource-server contract.
- [`tokens-vectors.json`](tokens-vectors.json) contains conformance vectors for that contract.
- [`verify_token.py`](verify_token.py) is the reference verifier used by the vectors.
- [`deploy.md`](deploy.md) defines the application/infrastructure boundary, artifact promotion, and Caddy ownership.
- [`FRAME-ui.md`](FRAME-ui.md) is the decision record for the shared `@herkules/ui` layer: Tailwind v4 + shadcn, and the TanStack Router verdict.
- [`public-release.md`](public-release.md) records publication, audit scope, and ongoing safeguards.
- [`SECURITY.md`](../SECURITY.md) explains how to report a vulnerability privately.

Component-specific operation and binding decisions belong in that component's README.
