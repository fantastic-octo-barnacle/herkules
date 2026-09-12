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

Both receive 100,000 test quota. The links select the requested identity even if
another account is signed in. Use separate browser profiles or a private window to
compare them simultaneously; tabs in one browser share the portal session.
Alice can manage users, quota, channels and models. Bob can use chat, keys, usage
and account/security; his requests to administrator APIs are rejected. The root
account remains private for system-wide configuration.
The API is http://127.0.0.1:4010/v1. Responses come from a deterministic mock;
this command never uses the GPU or production credentials. On macOS, Docker must
support `host.docker.internal` reaching loopback services, as OrbStack does.

In another terminal:

```sh
python3 tools/ai/smoke.py
```

This verifies real New API sign-in, token creation, serialized concurrent requests,
exact quota charges, quota exhaustion, and immediate Herkules revocation. It restores
Alice afterward and leaves its named test key and usage records in the local database.
New users start with zero quota. To give an account quota, open the private local
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

## Worker setup

Build with `vp run @herkules/inference#build`. Copy **all** emitted `.mjs` files from
`services/inference/dist` to `/opt/herkules-ai` on each GPU box. Install Node 24 at
`/usr/bin/node`. Install `worker.service` as `herkules-ai-worker.service`.

The existing llama-server should listen only on `127.0.0.1:8080`, require the key in
`/etc/herkules-ai/worker.key`, enable `--slots`, use alias `qwen3.8-27b`, and have one
131072-token slot. Keep its existing quantization and MTP flags. Generate a separate
random 32-byte adapter key in `/etc/herkules-ai/adapter.key`, mode 600. The unit uses
systemd credentials so the dynamic service user can read the two keys.

Enable and start the adapter. Test its authenticated `/healthz` and streaming endpoint
locally before changing the Cloudflare published application origin to
`http://localhost:8081`. Keep the existing `gpu-4090.herkules.dev` hostname and Access
Service Auth policy. Anonymous requests must fail at Access; Access-only requests
must fail at the adapter; both credentials must produce a streamed response.

The adapter checks actual llama slots before each request, counts the templated
prompt, rejects prompt-plus-output above 131072, and emits heartbeat comments during
prefill. A gateway restart cannot admit overlapping work to a busy model server.
Do not route the published application back to port 8080 after this cutover.

## GPU monitoring

The GPU host is registered as `gpu-4090` at `https://ops.herkules.dev`.
`beszel-agent.service` runs the native agent at `/usr/local/bin/beszel-agent`,
version 0.18.8 to match the hub. Its unit is recorded in `beszel-worker.service`.
The host-owned `/etc/beszel-agent/agent.env` contains the hub public key and
registration token, `HUB_URL=https://ops.herkules.dev`, `SYSTEM_NAME=gpu-4090`,
`GPU_COLLECTOR=nvidia-smi`, and `DISABLE_SSH=true`. Keep that file root-owned,
mode 600. Monitoring uses an outbound WebSocket; no inbound monitoring port is needed.

The agent reports GPU utilization, VRAM, temperature and power, plus CPU, RAM,
disks, network and the `llama-server`, `herkules-ai-worker`, `cloudflared` and
`beszel-agent` service states. Its persistent identity lives in
`/var/lib/beszel-agent`. Check it with `systemctl status beszel-agent`.

## Real Herkules authentication

Production uses `https://herkules.dev/auth` for browser sign-in and
`http://auth:3001/auth` for private membership checks. The provisioning script sets
`AI_PORTAL_ORIGIN`, `AI_CLIENT_SECRET` and `AI_SYNC_SECRET` in the auth service's
environment and writes the matching gateway credentials. On restart, auth registers
the `herkules-ai` client with the exact portal callback. The gateway configures New
API's Herkules provider automatically.

The fixture runner is only for isolated previews. Do not point its existing database
at the production issuer: Alice and Bob belong to the fixture issuer, and their
identities and quotas must stay separate from real members. Production starts with
its own database and zero quota for new members. The preview script's administrator
promotion is local-only; promote the first real administrator through the private
New API interface after their Herkules sign-in.

## Production provisioning and activation

AI is an opt-in `ai` Compose profile. The ordinary release can deploy without AI
credentials. Its two AI hostnames return an unavailable response until the profile
is running. The gateway uses the auth release image in a **separate container**,
executing `/ai/dist/main.mjs`; AI source changes rebuild that image automatically.
New API is pinned to `v1.0.0-rc.37` and its immutable multi-platform digest. It is an
upstream release candidate; upgrades require rerunning the integration tests.

After deploying this branch's auth image and release configuration on `tencent_hk`:

1. Run `sudo python3 tools/ai/prepare-production.py /home/<deploy-user>/herkules`
   from a checkout containing this script. It creates a dedicated `herkules_ai`
   database/owner, a separate `ai_metadata` role, persistent random credentials,
   and the auth service's confidential client configuration. It preserves unrelated
   `.env.auth` settings and does not restart anything. Back up that env file first.
2. Stage the adapter key, Cloudflare client ID and client secret as
   `/etc/herkules-ai/gateway/{adapter-key,cf-access-client-id,cf-access-client-secret}`.
   Files and their mounted directory must be owned by UID/GID 1000, directory 700,
   files 400. Copy via SSH stdin or a secure file transfer; never put values in shell
   arguments, Git, chat, or CI logs. `save-access-token.py` accepts either bare values
   or copied `CF-Access-…: value` headers on the development computer.
3. Start only New API: `sh compose.sh --profile ai up -d new-api`. Wait for healthy,
   then run the provisioning script again with `--metadata`. Its restricted SQL view
   exposes only API-key hashes and user IDs; the gateway cannot read raw keys or
   change accounts. New API still validates every key.
4. Recreate auth to read its updated env: `sh compose.sh up -d --force-recreate auth`.
   Then start the gateway: `sh compose.sh --profile ai up -d inference`. Check
   its health privately and complete the real-worker smoke test.
5. Set `COMPOSE_PROFILES=ai` and `AI_BACKUP_DATABASE=herkules_ai` in the server's `.env`.
   Recreate backup so the existing nightly R2 job includes the AI database. Run a
   manual backup and verify a restore before admitting users. The AI ledger, keys,
   bindings, channels and settings are all in that database; preserve server-owned
   credential files separately. The New API local data directory is not authoritative.
6. Proxy DNS for `ai.herkules.dev` and `ai-portal.herkules.dev` to the VPS through
   Cloudflare Full (strict). Caddy validates both names against the existing Origin
   CA certificate. Bypass caching and interactive browser challenges on the API
   hostname; clients authenticate using API keys. Keep the worker's Access policy.

The break-glass root login is blocked at the public portal. Reach it with
`ssh -L 4014:127.0.0.1:4014 tencent_hk` and http://localhost:4014. Use it to promote a
Herkules-bound account to administrator. Normal administrators then manage users and
limits from the public portal. Do not remove the Herkules provider or repoint the
managed `herkules-dispatch` channel; bootstrap reconciles those settings.

## Limits and administration

Default output is 4096 tokens, maximum 8192. Only text messages, streamed chat completions and model
listing are public initially. One request can run per user; two may wait per user,
16 globally, for at most 90 seconds. This is one gateway process; do not scale the
gateway horizontally without replacing its in-memory scheduler and ticket store.
Multiple GPU workers are supported by adding entries to the mounted `workers.json`
and restarting the gateway. Workers sharing a model alias must use compatible model
weights and templates. A busy or unavailable worker fails the request without an
automatic retry, avoiding duplicate generations and charges.

Initial pricing is one quota unit per prompt token and two per generated token.
These are capacity credits, not a currency price. Per-user model request limits start
at 20 per minute. New API owns token quotas, expiration, model restrictions and the
usage ledger. Operator pricing and rate counts survive restarts. New accounts get
zero credits until an administrator assigns them.

Private management API examples, using an administrator's dashboard bearer token:

- `GET /api/user/?p=1&page_size=100`: users and quota balances.
- `POST /api/user/manage` with `{"id":2,"action":"add_quota","mode":"override","value":100000}`:
  set remaining credits. Modes `add` and `subtract` adjust an existing balance.
- `POST /api/user/manage` with `{"id":2,"action":"disable"}`: revoke that account.
- `GET /api/log/`: usage records. Personal key management uses `/api/token/`.

Use the portal's current administration authentication flow or scoped management
credentials; inference `sk-` keys are not administrator credentials. Herkules account
disable is checked at each admission, including after queueing; background reconciliation
also disables the New API account. Re-enable both accounts explicitly after a revocation.
An already-running generation may finish. If membership checks fail, new work fails closed.

Prompts and responses are not application logs. Keep DEBUG and error body logging off.
The pinned New API schema is part of this integration: review the metadata view and
session APIs before upgrading. Initial operations are manual; the current branch does
not change DNS, tunnel routes, GPU flags, or enable the production profile automatically.

## Simplified interface

`SidebarModulesAdmin` hides wallet/referrals, subscription and redemption tools,
image/video task logs, and the redundant chat link. Model Square and rankings are
hidden from the header. Empty API-info, FAQ, announcements and uptime panels are
also hidden. Quota balances, usage logs, profile, language preferences
and security remain. Administrators retain users, channels and model management.
Referral rewards and check-in rewards are disabled. SMTP configuration is cleared
and notification preferences are removed from the profile page.

The few hard-coded controls require a frontend-only patch in `portal/edits.json`.
The backend stays on the original pinned image. The gateway serves the patched
frontend; the auth release image includes it. Build input is pinned by commit and
archive checksum, and patches must match exactly. Both original attribution and a
link to the complete modified source archive remain in the portal footer. The
private break-glass interface on port 4014 still uses the upstream UI.
