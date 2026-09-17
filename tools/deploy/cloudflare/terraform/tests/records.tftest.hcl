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

  # The twelve records captured from the zone export on 2026-09-14 plus the eight
  # CAA records added on 2026-09-15, plus `lark` (larkstack) on 2026-09-17. A missing entry would drop a live record out of
  # management without deleting it, which is the quiet kind of drift; make it loud.
  assert {
    condition = keys(cloudflare_dns_record.record) == [
      "ai", "ai_portal", "apex", "bbs", "caa_google_issue", "caa_google_issuewild",
      "caa_letsencrypt_issue", "caa_letsencrypt_issuewild", "caa_sectigo_issue",
      "caa_sectigo_issuewild", "caa_sslcom_issue", "caa_sslcom_issuewild",
      "capability_map", "dkim", "dmarc", "gpu_4090", "lark", "ops", "spf", "status", "www",
    ]
    error_message = "The managed record set changed. Update this list only alongside a reviewed zone change."
  }

  # CAA: every CA Cloudflare may use for the Universal certificate is allowed for
  # both the apex and the wildcard, all on the apex name, and none is proxied.
  # Dropping a CA here would block the next renewal if Cloudflare rotates to it.
  assert {
    condition = alltrue([
      for ca in ["pki.goog", "letsencrypt.org", "ssl.com", "sectigo.com"] :
      alltrue([
        for tag in ["issue", "issuewild"] :
        length([
          for r in cloudflare_dns_record.record : r
          if r.type == "CAA" && r.name == var.root_domain && !r.proxied &&
          r.data.tag == tag && startswith(r.data.value, ca)
        ]) == 1
      ])
    ])
    error_message = "CAA must allow issue and issuewild for each of pki.goog, letsencrypt.org, ssl.com and sectigo.com, on the apex, unproxied."
  }

  # No record carries both shapes. A CAA with `content` or an A with `data` would
  # be rejected by the API at apply, not by validate.
  assert {
    condition = alltrue([
      for r in cloudflare_dns_record.record :
      (r.type == "CAA") == (r.data != null)
    ])
    error_message = "CAA records use `data`; every other record uses `content`."
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
