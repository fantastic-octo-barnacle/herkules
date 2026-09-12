# Inference gateway

New API owns the portal, API keys, quota ledger and management APIs. This service
owns worker scheduling, the public route boundary and Herkules account revocation.
The portal is `ai-portal.herkules.dev`; inference is `ai.herkules.dev/v1`.

Run `vp run build` and `vp test` in this workspace. The isolated local stack and
credential setup are documented in `tools/ai/README.md`.

## Boundaries

- New API is pinned by digest in Compose. Do not edit its tables to configure
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

`AI_PORTAL_DIR` selects the checksum-pinned, frontend-only customization of New API.
Production packages it in `/ai/portal`; local startup builds it outside the checkout.
The backend's own UI is only used on its private administration port. The source
archive linked in the footer contains the exact modified upstream source and build
instructions. See `tools/ai/portal/edits.json` for the small UI patch.
