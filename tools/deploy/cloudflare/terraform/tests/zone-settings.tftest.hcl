# Credential-free invariants for the zone TLS and security settings, run by
# `terraform test` in the normal CI job next to the records and Access files.
#
# The provider is mocked, so nothing here talks to Cloudflare. The authoritative
# check that each setting individually matches the live zone is `terraform plan`
# converging to no changes after import; these assertions guard the properties a
# refactor could quietly drop -- which for a TLS setting means an outage or a
# downgrade nobody notices.

# `cloudflare_ruleset.zone_id` is validated as 32 hexadecimal characters, and a mock
# provider hands a data source a short random string instead. Every test file plans
# the whole configuration, so pin the zone id here too or the redirect ruleset in
# zone-rules.tf fails the plan. Nothing in this file reads the value.
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

run "settings" {
  command = plan

  # The adopted set: nine string settings, no more. Dropping one takes it out of
  # management without changing it (this resource's Delete is a no-op), which is
  # silent drift; adding one widens the pass beyond what was reviewed.
  assert {
    condition = keys(cloudflare_zone_setting.string) == [
      "always_use_https", "automatic_https_rewrites", "brotli", "browser_check",
      "http3", "min_tls_version", "opportunistic_encryption", "ssl", "tls_1_3",
    ]
    error_message = "The managed zone-setting set changed. Update this list only alongside a reviewed TLS change."
  }

  # The three settings that are the contract with the VPS and the Origin CA cert.
  assert {
    condition     = cloudflare_zone_setting.string["ssl"].value == "strict"
    error_message = "SSL must stay strict (full end-to-end validation of the Origin CA cert)."
  }
  assert {
    condition     = cloudflare_zone_setting.string["tls_1_3"].value == "on"
    error_message = "TLS 1.3 must stay enabled."
  }
  assert {
    condition = alltrue([
      for id in ["always_use_https", "automatic_https_rewrites", "opportunistic_encryption"] :
      cloudflare_zone_setting.string[id].value == "on"
    ])
    error_message = "Plain-HTTP requests and mixed content must keep being rewritten or redirected."
  }

  # A real floor: the API accepts 1.0 and 1.1, so this is what stops a quiet
  # downgrade of the handshake the Origin CA contract runs over.
  assert {
    condition     = contains(["1.2", "1.3"], cloudflare_zone_setting.string["min_tls_version"].value)
    error_message = "min_tls_version must stay at or above 1.2."
  }

  assert {
    condition = alltrue([
      for id in ["brotli", "http3", "browser_check"] :
      cloudflare_zone_setting.string[id].value == "on"
    ])
    error_message = "Brotli, HTTP/3 and Browser Integrity Check must stay enabled."
  }

  # `http2` is reported not editable on this plan. Managing it would fail at apply,
  # so its absence is the invariant.
  assert {
    condition     = !contains(keys(cloudflare_zone_setting.string), "http2")
    error_message = "http2 is not editable on this plan and must not be managed."
  }

  # HSTS is on, for every subdomain, and browsers remember it for max_age. The
  # floor guards against a token value that would make the header decorative;
  # `preload` is pinned off because submitting the domain to the browser preload
  # lists is a one-way door that needs its own review.
  assert {
    condition = (
      cloudflare_zone_setting.hsts.setting_id == "security_header" &&
      cloudflare_zone_setting.hsts.value.strict_transport_security.enabled &&
      cloudflare_zone_setting.hsts.value.strict_transport_security.include_subdomains &&
      cloudflare_zone_setting.hsts.value.strict_transport_security.max_age >= 2592000 &&
      !cloudflare_zone_setting.hsts.value.strict_transport_security.preload
    )
    error_message = "HSTS must stay enabled with include_subdomains, a max_age of at least 30 days, and preload off."
  }
}
