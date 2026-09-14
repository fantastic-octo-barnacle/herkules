# Cloudflare Access for the two Zero Trust applications on the GPU host, plus the
# two account-level (reusable) policies they reference.
#
# Adopted 2026-09-14 from a read of the live account. Exactly two self-hosted
# applications exist, `capability-map` and `gpu-4090`, and exactly two reusable
# policies, each attached to one of them. The account has no other Access
# applications, no Access groups, and no reusable policy beyond these two.
#
# There is deliberately **no** application for the VPS-hosted hostnames.
# `ai-portal.herkules.dev` never reaches Access: an anonymous request is answered
# by the portal's own `/dashboard` redirect. Older notes in this repository claimed
# it sat behind Access; the account and the wire both say otherwise. See
# docs/cloudflare-terraform.md §8.
#
# Provider 5.25 shape, taken from the provider's own schema rather than the resource
# docs' prose: an application attaches policies by reference through its `policies`
# list of `{ id, precedence }`. `cloudflare_zero_trust_access_policy` is the
# ACCOUNT-LEVEL reusable policy and has no `application_id` argument in this provider
# line -- it imports as `<account_id>/<policy_id>`. An entry without an `id` would
# make the provider create a second policy instead of attaching the existing one.
#
# Deliberately NOT managed here:
#   - The Herkules OIDC identity provider and the `herkules-ai-gateway` service
#     token. Both carry a `client_secret` that is Sensitive in the schema and
#     PLAINTEXT in state, and both must already exist in the auth service's
#     `.env.auth` and on the GPU host. Managing them would copy a secret into state
#     without removing a manual step. The service token is read through a data
#     source, which exposes no secret; the IdP is referenced by variable id.
#   - The Zero Trust organization (`cloudflare_zero_trust_organization`). The
#     provider cannot import it, so `is_ui_read_only` -- the setting that would
#     actually stop dashboard drift -- stays a documented manual step.

locals {
  # Cloudflare reports `connection_rules = { rdp = {} }` on account-level policies
  # that have no connection restrictions. It is inert, but omitting it makes every
  # plan propose an in-place update, so it is declared once and matched exactly.
  no_connection_rules = { rdp = {} }
}

data "cloudflare_zero_trust_access_service_token" "ai_gateway" {
  account_id = var.account_id

  # Looked up by name, not by id: this data source is verified to expose no
  # `client_secret` (unlike the identity provider's), so nothing secret can reach
  # state, and deleting or renaming the token fails the plan loudly instead of
  # silently detaching the policy from the only credential that can reach the
  # inference worker.
  filter = {
    name = var.service_token_name
  }
}

resource "cloudflare_zero_trust_access_policy" "herkules_team" {
  account_id = var.account_id
  name       = "Herkules team"
  decision   = "allow"

  # Identity-based: anyone who can authenticate through the Herkules OIDC provider.
  # This is the login method, not a group or email-domain restriction, so it is
  # exactly as wide as the auth service's own registration policy. Widening or
  # narrowing it is a deliberate change, not part of an adoption pass.
  include = [{ login_method = { id = var.oidc_idp_id } }]

  connection_rules = local.no_connection_rules
}

resource "cloudflare_zero_trust_access_policy" "ai_gateway" {
  account_id = var.account_id
  name       = "AI Gateway only"
  decision   = "non_identity"

  # Service Auth: the only thing that can reach the inference worker is the token
  # the gateway presents. An anonymous browser request gets 403, not a login page.
  include = [{ service_token = { token_id = data.cloudflare_zero_trust_access_service_token.ai_gateway.id } }]

  connection_rules = local.no_connection_rules
}

resource "cloudflare_zero_trust_access_application" "capability_map" {
  account_id = var.account_id
  name       = "Capability Map"
  type       = "self_hosted"

  # `destinations` supersedes the deprecated `self_hosted_domains`, which is left
  # unset everywhere in this file.
  destinations = [{ type = "public", uri = "capability-map.herkules.dev" }]

  session_duration          = "24h"
  allowed_idps              = [var.oidc_idp_id]
  auto_redirect_to_identity = true
  app_launcher_visible      = true

  # All three are `false` on the live application. They must be stated:
  # `http_only_cookie_attribute` in particular defaults to `true` in the provider,
  # so omitting it silently changes the Access cookie the origin receives.
  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false

  policies = [{ id = cloudflare_zero_trust_access_policy.herkules_team.id, precedence = 1 }]

  lifecycle {
    # A mistyped domain would otherwise plan as destroy + create, i.e. an outage
    # for the service behind it. This makes that fail loudly instead. It guards
    # destroy and replace only; in-place updates still need reading.
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "gpu_4090" {
  account_id = var.account_id
  name       = "Herkules GPU 4090"
  type       = "self_hosted"

  destinations = [{ type = "public", uri = "gpu-4090.herkules.dev" }]

  session_duration = "24h"

  # `allowed_idps` is intentionally unset. The live application reports an empty
  # list, and an explicit `[]` plans as a change against that. It does not matter
  # for reachability: the only policy on this application is non_identity, so no
  # interactive login exists here in the first place.
  auto_redirect_to_identity = false
  app_launcher_visible      = true

  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false

  policies = [{ id = cloudflare_zero_trust_access_policy.ai_gateway.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}
