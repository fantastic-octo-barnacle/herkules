# Credential-free invariants, run by `terraform test` in the normal CI job.
#
# The provider is mocked, so nothing here talks to Cloudflare. The authoritative
# check that every record is individually correct is `terraform plan` converging
# to no changes after import; these assertions guard the things a refactor could
# silently drop.

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

run "records" {
  command = plan

  # The record set captured from the zone export on 2026-09-14. A missing entry
  # would drop a live record out of management without deleting it, which is the
  # quiet kind of drift; make it loud.
  assert {
    condition = keys(cloudflare_dns_record.record) == [
      "ai", "ai_portal", "apex", "bbs", "capability_map", "dkim",
      "dmarc", "gpu_4090", "ops", "spf", "status", "www",
    ]
    error_message = "The managed record set changed. Update this list only alongside a reviewed zone change."
  }

  # Losing these lets anyone spoof the domain.
  assert {
    condition     = cloudflare_dns_record.record["spf"].content == "v=spf1 -all"
    error_message = "SPF must stay hard-fail (-all)."
  }
  assert {
    condition     = startswith(cloudflare_dns_record.record["dmarc"].content, "v=DMARC1; p=reject")
    error_message = "DMARC must stay p=reject."
  }
  assert {
    condition     = cloudflare_dns_record.record["dkim"].content == "v=DKIM1; p="
    error_message = "The wildcard DKIM selector must keep its empty (revoked) key."
  }

  # Every A record is the VPS; nothing serves from anywhere else.
  assert {
    condition = alltrue([
      for r in cloudflare_dns_record.record : r.content == var.origin_ipv4 && r.proxied
      if r.type == "A"
    ])
    error_message = "Every A record must be proxied and point at origin_ipv4."
  }

  # The box has no IPv6; an AAAA record would send proxied traffic nowhere.
  assert {
    condition     = length([for r in cloudflare_dns_record.record : r if r.type == "AAAA"]) == 0
    error_message = "No AAAA records: the origin has no IPv6."
  }

  # Cloudflare reports "automatic" (1) for every live record.
  assert {
    condition     = alltrue([for r in cloudflare_dns_record.record : r.ttl == 1])
    error_message = "All records use Cloudflare's automatic TTL (1)."
  }

  assert {
    condition     = cloudflare_dns_record.record["apex"].name == var.root_domain
    error_message = "The apex record must resolve to the bare root domain."
  }
}
