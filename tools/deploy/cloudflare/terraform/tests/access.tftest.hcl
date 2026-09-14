# Credential-free invariants for the Access configuration, run by `terraform test`
# in the normal CI job next to tests/records.tftest.hcl.
#
# The provider is mocked, so nothing here talks to Cloudflare. The authoritative
# check that every application and policy individually matches the live account is
# `terraform plan` converging to no changes after import; these assertions guard the
# properties a refactor could quietly drop. The most important one is that each
# application *references* an adopted policy: a policy entry without an `id` makes
# the provider create a second policy, leaving the live one attached and effectively
# unreviewed.

mock_provider "cloudflare" {}

# The service token's id comes from a real API read, so it is "known after apply"
# while this file only plans. `override_during = plan` makes a fixed, fake value
# available so the assertions below can inspect the service_token rule. This file
# never talks to Cloudflare either way.
override_data {
  target          = data.cloudflare_zero_trust_access_service_token.ai_gateway
  override_during = plan
  values = {
    id = "00000000-0000-0000-0000-0000000000a1"
  }
}

# The applications reference these ids, so the application objects are not fully
# known during a plan. Pin them to fake values for the same reason: the invariant
# being protected is that each referenced policy HAS an id. An entry without one
# makes the provider create a second policy instead of attaching the adopted one.
override_resource {
  target          = cloudflare_zero_trust_access_policy.herkules_team
  override_during = plan
  values = {
    id = "00000000-0000-0000-0000-0000000000b1"
  }
}

override_resource {
  target          = cloudflare_zero_trust_access_policy.ai_gateway
  override_during = plan
  values = {
    id = "00000000-0000-0000-0000-0000000000b2"
  }
}

variables {
  api_token = "unused-under-mock-provider"
}

run "access" {
  command = plan

  # The adopted set: two applications, no more. Dropping one takes a live
  # application out of management without deleting it, which is the quiet kind of
  # drift; adding one means a second application was created by accident.
  assert {
    condition = (
      cloudflare_zero_trust_access_application.capability_map.name == "Capability Map" &&
      cloudflare_zero_trust_access_application.gpu_4090.name == "Herkules GPU 4090"
    )
    error_message = "The managed Access application set changed. Update this test only alongside a reviewed Zero Trust change."
  }

  # Both are public self-hosted destinations described through `destinations`. The
  # deprecated `self_hosted_domains` must stay unset: it is the field that silently
  # conflicts when both are present.
  assert {
    condition = (
      cloudflare_zero_trust_access_application.capability_map.destinations[0].uri == "capability-map.herkules.dev" &&
      cloudflare_zero_trust_access_application.gpu_4090.destinations[0].uri == "gpu-4090.herkules.dev"
    )
    error_message = "Declare each Access destination through `destinations`, one public hostname per application."
  }

  # Every application carries policies, and every entry is a reference to an
  # adopted policy -- an id, at precedence 1. An entry without an id creates a new
  # policy instead of attaching the existing one.
  assert {
    condition = alltrue([
      for app in [
        cloudflare_zero_trust_access_application.capability_map,
        cloudflare_zero_trust_access_application.gpu_4090,
      ] : length(app.policies) >= 1 && alltrue([for p in app.policies : p.id != null && p.precedence == 1])
    ])
    error_message = "Each application needs at least one referenced policy (with an id and precedence), never an inline copy."
  }

  # The identity application is reachable only through the Herkules OIDC provider,
  # and it skips the provider picker. `allowed_idps` is a set, so it is compared
  # with `toset` rather than a list literal.
  assert {
    condition = (
      cloudflare_zero_trust_access_application.capability_map.allowed_idps == toset([var.oidc_idp_id]) &&
      cloudflare_zero_trust_access_application.capability_map.auto_redirect_to_identity
    )
    error_message = "capability-map must stay reachable only through the Herkules OIDC provider."
  }

  # The worker application is Service Auth: a non_identity policy holding exactly
  # one service token, and no identity rule at all.
  assert {
    condition = (
      cloudflare_zero_trust_access_policy.ai_gateway.decision == "non_identity" &&
      length([for rule in cloudflare_zero_trust_access_policy.ai_gateway.include : rule if rule.service_token != null]) == 1
    )
    error_message = "gpu-4090 must stay reachable only by the service token (non_identity)."
  }

  # The identity policy stays an allow on the login method -- not an email list,
  # which would survive a change to the auth service's registration policy.
  # `include` is a set, so it is read with `one()` rather than an index.
  assert {
    condition = (
      cloudflare_zero_trust_access_policy.herkules_team.decision == "allow" &&
      one([for rule in cloudflare_zero_trust_access_policy.herkules_team.include : rule.login_method.id if rule.login_method != null]) == var.oidc_idp_id
    )
    error_message = "The Herkules team policy must stay an allow on the Herkules OIDC login method."
  }

  # The live value is false while the provider's default is true, so a dropped
  # attribute would silently change the cookie Access issues to the origin.
  assert {
    condition = (
      !cloudflare_zero_trust_access_application.capability_map.http_only_cookie_attribute &&
      !cloudflare_zero_trust_access_application.gpu_4090.http_only_cookie_attribute
    )
    error_message = "http_only_cookie_attribute must stay explicitly false, matching the live applications."
  }
}
