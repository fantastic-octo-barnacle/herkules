# AI hosting

The API is `https://ai.herkules.dev/v1`; the portal is
`https://ai-portal.herkules.dev`. The main site has an AI service card; `/ai` redirects
to the portal. New API provides the dashboard, keys, usage ledger
and administrator APIs. Herkules controls membership; the inference gateway owns
admission and worker selection. Only the gateway carries worker credentials.

## Test on this computer

Requirements: the repository's Vite+ toolchain, Bun 1.4+, Docker with Compose, and Python 3.
The first start builds the customized portal from checksum-pinned upstream source.
Subsequent starts reuse it until the patch or build script changes.

```sh
vp install
node tools/ai/dev.mjs
```

Open http://localhost:4010, choose **Herkules**, then **Alice** or **Bob**.
To create both preview accounts and verify their permissions, run:

```sh
python3 tools/ai/preview-accounts.py
```

- Administrator: http://localhost:4012/preview/alice
- Regular member: http://localhost:4012/preview/bob

Both receive 100,000 permanent test credits in addition to Lite weekly allowances. The links select the requested identity even if
another account is signed in. Use separate browser profiles or a private window to
compare them simultaneously; tabs in one browser share the portal session.
Alice can manage users, quota, channels and models. Bob can use chat, keys, usage
and account/security; his requests to administrator APIs are rejected. The root
account remains private for system-wide configuration.
The API is http://127.0.0.1:4010/v1. Responses come from a deterministic mock;
this command never uses the GPU or production credentials. The DeepSeek aliases also use the mock worker in this preview. On macOS, Docker must
support `host.docker.internal` reaching loopback services, as OrbStack does.

In another terminal:

```sh
python3 tools/ai/smoke.py
```

This verifies real New API sign-in, token creation, serialized concurrent requests,
exact quota charges, quota exhaustion, and immediate Herkules revocation. It restores
Alice afterward and leaves its named test key and usage records in the local database.
New users receive Lite weekly allowances; their permanent wallet starts at zero. To give an account quota, open the private local
admin at http://localhost:4014, sign in as `herkulesroot`, and read its password from
`~/.config/herkules/ai/dev/root-password` into your password manager. Assign quota in
User management. The smoke test gives Alice 100,000 units.

All generated local secrets are outside Git under `~/.config/herkules/ai/dev`, with
restricted permissions. The local auth fixture uses fake GitHub users and a separate
PGlite database. It binds loopback and is never included in the auth runtime package.
Do not expose these development ports through a tunnel or reverse proxy.

Ctrl-C stops host processes; `node tools/ai/dev.mjs stop` stops the preview runner
and its Docker containers. Restarting preserves accounts, usage and credentials. The private admin
and PostgreSQL ports are loopback-only. Gateway dispatch requires a secret and a
single-use ticket even on the local Docker network.

## Production hosting

Worker setup, systemd units, model presets and production provisioning have moved to
[herkules-infra/tools/ai](https://github.com/trident-rm/herkules-infra/tree/main/tools/ai).
Application worker and gateway builds remain in `services/inference`; local preview,
portal customization and benchmark tools remain here.
