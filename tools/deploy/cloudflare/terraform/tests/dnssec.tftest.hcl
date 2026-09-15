# Credential-free invariant for DNSSEC, run by `terraform test` in the normal CI
# job next to the other files. The provider is mocked, so nothing here talks to
# Cloudflare.

# `cloudflare_ruleset.zone_id` is validated as 32 hexadecimal characters, and a mock
# provider hands a data source a short random string instead. Every test file plans
# the whole configuration, so pin the zone id here too or the redirect ruleset in
# zone-rules.tf fails the plan.
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

run "dnssec" {
  command = plan

  # The whole point of the resource: signing stays on. The provider's Delete
  # disables DNSSEC and removes the keys while the DS record is still at the
  # registrar, so "disabled" here is an outage, not a setting.
  assert {
    condition     = cloudflare_zone_dnssec.this.status == "active"
    error_message = "DNSSEC must stay active; the DS record at the registrar depends on it."
  }
}
