# Credential-free invariant for Certificate Transparency alerting, run by
# `terraform test` in the normal CI job next to the other files. The provider is
# mocked, so nothing here talks to Cloudflare -- and the real endpoint needs the
# `SSL and Certificates` permission, which is exactly the kind of thing a live plan
# cannot check.

# Every test file plans the whole configuration, so the zone id has to be pinned here
# too or the redirect ruleset in zone-rules.tf fails its 32-hex-character validation.
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

run "ct_alerting" {
  command = plan

  # Enabled with nowhere to send the alert is the failure mode worth catching: the
  # subscription is on, it never notifies anyone, and nothing in the dashboard says
  # so. Cloudflare accepts an empty list and stores it.
  assert {
    condition     = cloudflare_ct_alerting.this.enabled == true
    error_message = "CT alerting must stay enabled; it is what notices issuance CAA did not prevent."
  }

  assert {
    condition     = length(cloudflare_ct_alerting.this.emails) > 0
    error_message = "CT alerting needs at least one recipient, or the alert goes nowhere."
  }
}
