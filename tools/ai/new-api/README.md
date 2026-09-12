# New API subscription pools

The backend source is pinned to `385d2dfd10d821b25c8a6766bd16eea248cb1652`, the same
revision as the portal. `portal/build.mjs` verifies the upstream archive checksum,
applies `patch.py`, and publishes the complete modified source as
`/portal-source.tar.gz`. The shared release image includes the compiled backend.

This extension adds `herkules_pool` to subscription plans. With
`HERKULES_PLANS_ENABLED=true`, subscriptions fund only matching pools. Exact model
IDs in `HERKULES_CLOUD_MODELS` use cloud subscriptions and cannot fall back to a
wallet, even if the caller changes billing preference. Other models use local
subscriptions. The public gateway independently allowlists hosted models. Native
New API transactions still reserve, settle, refund, and reset quotas.

Free administrator grants do not require enabling payment processing. Payment
routes remain disabled at the public gateway. The original payment compliance
checks still apply to purchases.

`go test ./model -run TestHerkules -count=1` checks pool matching, actual reservation
isolation, refunds, exhaustion, and wallet fallback. The Docker backend build runs
these tests before compiling. Use `docker build --target new-api -t
herkules-new-api-dev .` from the repository root to build the local backend.

The added column is backward-compatible with the original backend, but **do not
roll back to the original binary while a cloud channel is enabled**: the original
billing code ignores pool isolation. Disable the cloud channel before such a rollback.
