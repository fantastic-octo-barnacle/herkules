# Credential-free invariants for the zone's redirect ruleset (Phase D), run by
# `terraform test` in the normal CI job next to the records, Access and settings
# files.
#
# The provider is mocked, so nothing here talks to Cloudflare. The authoritative
# check that the rule matches the live zone is `terraform plan` converging to no
# changes after import; these assertions guard the properties a later edit could
# quietly drop. For a redirect the quiet failures are specific: a target that stops
# carrying the path, a match that stops being HTTPS-scoped, or a query string that
# arrives twice.

# `cloudflare_ruleset.zone_id` is validated as 32 hexadecimal characters, and a mock
# provider hands a data source a short random string instead. Pin a well-formed one so
# the configuration plans; the real value is checked by `terraform plan` after import.
mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = {
      id = "0123456789abcdef0123456789abcdef"
    }
  }
}

variables {
  api_token = "unused-under-mock-provider"
}

run "redirect" {
  command = plan

  # The adopted scope: one zone-kind ruleset in the one phase the survey found
  # populated, holding one rule. The cache, config and custom-WAF phases are empty
  # live (`404` code `10003`), so a ruleset in any of them would mean this pass grew
  # past what was reviewed rather than adopted something.
  assert {
    condition = (
      cloudflare_ruleset.redirect.kind == "zone" &&
      cloudflare_ruleset.redirect.phase == "http_request_dynamic_redirect" &&
      length(cloudflare_ruleset.redirect.rules) == 1
    )
    error_message = "The managed ruleset must stay the single zone-kind http_request_dynamic_redirect ruleset holding exactly one rule."
  }

  assert {
    condition = alltrue([
      for r in cloudflare_ruleset.redirect.rules : r.action == "redirect" && r.enabled
    ])
    error_message = "The www rule must stay an enabled redirect."
  }

  # HTTPS-only and matched on the full URI. This is what leaves plain-HTTP requests
  # to `always_use_https` in zone-settings.tf, and what stops the rule firing on the
  # apex or on any other hostname.
  assert {
    condition = alltrue([
      for r in cloudflare_ruleset.redirect.rules :
      strcontains(r.expression, "http.request.full_uri") &&
      strcontains(r.expression, "wildcard") &&
      strcontains(r.expression, "https://www.*")
    ])
    error_message = "The redirect must stay scoped to https://www.* on http.request.full_uri, not to a bare host match."
  }

  # The path -- and the query string, which rides inside `full_uri` -- survives the
  # hop only because the target is computed by `wildcard_replace` and references the
  # capture. A static target_url would send every `www` deep link to the apex
  # homepage, which is exactly the regression a "tidy-up" would introduce.
  #
  # `$${1}` is HCL for the literal `${1}` the rule needs.
  assert {
    condition = alltrue([
      for r in cloudflare_ruleset.redirect.rules :
      strcontains(r.action_parameters.from_value.target_url.expression, "wildcard_replace") &&
      strcontains(r.action_parameters.from_value.target_url.expression, "${1}")
    ])
    error_message = "The target must stay the wildcard_replace expression that carries the path and query across to the apex."
  }

  # `preserve_query_string = false` is the live value and is only correct *together*
  # with the expression above; enabling it would append the query string twice.
  assert {
    condition = alltrue([
      for r in cloudflare_ruleset.redirect.rules :
      r.action_parameters.from_value.preserve_query_string == false &&
      r.action_parameters.from_value.status_code == 301
    ])
    error_message = "Keep preserve_query_string false alongside the full_uri expression, and the status code 301."
  }
}
