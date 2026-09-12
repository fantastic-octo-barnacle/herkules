# Inference gateway

New API owns the portal, API keys, quota ledger and management APIs. This service
owns worker scheduling, the public route boundary and Herkules account revocation.
The portal is `ai-portal.herkules.dev`; inference is `ai.herkules.dev/v1`.

Run `vp run build` and `vp test` in this workspace. The isolated local stack and
credential setup are documented in `tools/ai/README.md`.

## Boundaries

- New API is compiled from checksum-pinned source with a small subscription-pool patch. Do not edit its tables to configure
  quotas or accounts; use its management APIs. A restricted SQL view supplies
  only API-key hashes and account IDs for queue fairness. New API still validates
  every API key and charges every generation itself.
- Every generation has a short-lived internal ticket assigned by the gateway.
  The New API channel forwards this ticket back to the internal dispatch route.
  A caller cannot choose a worker or inject gateway/worker credentials.
- Worker `capacity` and `perUser` control active requests, both defaulting to one.
  `perUser` compares against that user's total active requests across the gateway,
  preserving account-wide fairness across multiple workers. Two requests may wait per user, 16 globally, for 90 seconds. Entries sharing a
  physical GPU must share `resourceGroup`. Different models in that group run
  exclusively; an older model-switch request drains the active model before
  loading the next one. Worker slots stay reserved until each response ends.
- The worker adapter owns a second admission gate. After restarts it verifies
  llama-server's slots before admitting work. It emits SSE heartbeat comments
  during prefill and propagates cancellation. llama-server must enable `/slots`.
- Streaming chat completions and model listing are the initial public API.
  Non-streaming generation is rejected explicitly: long prefill cannot reliably
  fit Cloudflare's outer response timeout.
- Prompts, replies, credentials and authorization headers are not logged.
- Account status is checked against Herkules before inference. A periodic
  reconciliation disables revoked New API accounts through its management API;
  failures close the gateway until reconciliation recovers. Re-enabling an
  account is an explicit New API administrator action.

## Portal assets

`AI_PORTAL_DIR` selects the checksum-pinned, portal customization of New API.
Production packages it in `/ai/portal`; local startup builds it outside the checkout.
The backend's own UI is only used on its private administration port. The source
archive linked in the footer contains the exact modified upstream source and build
instructions. See `tools/ai/portal/edits.json` for the small UI patch.

## Model discovery and metadata

Authenticated `GET /v1/models` preserves New API's authorized model list and adds
OpenRouter-style `name`, `description`, `context_length`, `architecture`,
`supported_parameters`, `default_parameters`, and `top_provider` fields.
`GET /v1/models/{id}` retrieves an entry from that same authorized list. These are
compatible discovery extensions, not a claim of implementing OpenRouter's whole API.
Responses, embeddings, and vision are not advertised because Herkules does not
currently serve them. Metadata listing never loads a GPU model.

`herkules` contains versioned serving information: quantization, upstream source,
tags, reasoning-effort levels, configured slots, and streaming requirements.
Configured slots are not a live availability guarantee. Native context sizes are
not advertised as serving limits: the deployed per-slot context is 128K for the larger models and 32K for LFM2.5.
Credit prices remain in New API's pricing APIs; they must not be published as
OpenRouter USD prices. Existing OpenAI-compatible clients may ignore added fields.

`src/model-catalog.ts` supplies the catalog. `AI_MODEL_CATALOG_FILE` optionally
replaces it with a validated JSON map, useful when a deployment changes context
limits. The gateway fills omitted temperature/top-p from catalog defaults and
preserves explicit client values, including zero. Unknown models are unchanged.
The catalog does not claim unverified defaults for Gemma, Granite, or Mellum.

Bootstrap seeds missing New API `/api/models/` entries with descriptions, tags,
and the chat-completions endpoint. Existing administrator edits are retained,
and official metadata sync is disabled on seeded entries so native model claims
do not overwrite our serving capabilities. No database writes bypass New API.

The native llama.cpp router supports `tags` in `tools/ai/models.ini`; they are
informational and do not change routing aliases. It also forwards loaded-model
metadata in `/v1/models`, and `/props?model=...` exposes runtime defaults. Its
`/models` response can include filesystem paths and process arguments: do not
proxy it publicly. Updating preset files requires router reload, which can unload
changed models; apply only after draining active requests.

These surfaces use their existing formats. We do not emulate Ollama, Anthropic,
or Gemini discovery endpoints without also implementing their generation APIs.

## Plans and cloud models

Set `AI_PLANS_ENABLED=true` only with the patched backend from the same release.
New members receive Lite on their first authenticated portal/API request. Plans
have two independent weekly subscriptions, resetting Monday 00:00 Asia/Hong_Kong
without rollover: Lite 1M local + $0.50 cloud; Pro 5M + $5; Max 10M + $10.
One million cloud quota units represents US$1 of peak-rate allowance. Native New
API handles reservations, settlement, refunds, and resets. Existing wallet balances
are preserved and may fund only local models. Cancelling all plans does not silently
re-grant Lite. These are administrator-granted memberships with a 100-year term,
not paid subscriptions or automatic card charges.

The dashboard shows both pools. `GET /api/herkules/plan` returns the signed-in
member's allowance. An authenticated Herkules administrator can
`PUT /api/herkules/admin/users/{id}/plan` with `{"tier":"lite|pro|max"}`. Repeating
the same assignment preserves usage; changing tiers grants the new pair before
cancelling the old pair. If a backend call fails, retry the same assignment. Existing
grants retain their usage, and the old allowances remain until both replacements
exist. A partial change can temporarily leave both tiers active; automatic repair
does not refill the retiring tier. Assignment is privileged because it grants a fresh allowance. No user
self-upgrade or purchase route is exposed. The gateway remains a single process.

`AI_DEEPSEEK_KEY_FILE` enables `deepseek-flash` and `deepseek-v4-pro`. The credential
must be in a private server file. Bootstrap creates a dedicated New API channel;
cloud generation bypasses the GPU queue but retains API-key, membership and native
billing checks. There is no automatic paid fallback. Model listing exposes the
serving limits and peak-rate prices under `herkules.pricing`, with currency and unit.
DeepSeek's off-peak discount is not passed through dynamically; this keeps allowance
accounting conservative and predictable. The separate cloud subscription blocks
wallet fallback regardless of the user's billing preference.

This release does not add a global monthly spending counter. With no manual
re-grants, five weekly Max allowances total at most $50 of peak-rate credit in a
calendar month. Administrator grants and additional users increase aggregate spend;
use the provider account's spending controls for an independent global ceiling.
