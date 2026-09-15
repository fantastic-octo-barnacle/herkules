# The herkules.dev DNS records: the twelve imported from the live zone on 2026-09-14
# (A records to 124.156.183.221, two tunnel CNAMEs, three TXT records) and the CAA
# records added by the zone-hardening pass on 2026-09-15. See README.md for the
# import procedure, which must produce an empty plan before anything is applied.
#
# Deliberately NOT managed: SOA and NS records. Cloudflare owns these; managing
# them is a way to break the zone's delegation. The zone-level TLS and security
# settings are not records and live in `zone-settings.tf`.
#
# `private_routing` is intentionally left unset on every record. Terraform would
# otherwise assert its default (false) against records we have not read in full,
# and the first plan after import would try to change them.

locals {
  # Both tunnel CNAMEs terminate at the same tunnel on the GPU host, not the VPS.
  # These are plain DNS records: the tunnel's own remote configuration is not
  # managed here. If the tunnel later starts managing its DNS, it will fight this
  # file -- see README.md's warning before adopting tunnel config.
  gpu_tunnel = "aa133e92-6806-4814-ac80-3c80ad4a8b51.cfargotunnel.com"

  records = {
    # --- Proxied A records to the HK VPS -------------------------------------
    apex      = { type = "A", name = "@", content = var.origin_ipv4, proxied = true }
    www       = { type = "A", name = "www", content = var.origin_ipv4, proxied = true, comment = "Created during Cloudflare Rules deployment process for Redirect from WWW to root [Template]" }
    bbs       = { type = "A", name = "bbs", content = var.origin_ipv4, proxied = true }
    status    = { type = "A", name = "status", content = var.origin_ipv4, proxied = true }
    ops       = { type = "A", name = "ops", content = var.origin_ipv4, proxied = true }
    ai        = { type = "A", name = "ai", content = var.origin_ipv4, proxied = true }
    ai_portal = { type = "A", name = "ai-portal", content = var.origin_ipv4, proxied = true }

    # --- Proxied CNAMEs to the Cloudflare Tunnel -----------------------------
    gpu_4090       = { type = "CNAME", name = "gpu-4090", content = local.gpu_tunnel, proxied = true }
    capability_map = { type = "CNAME", name = "capability-map", content = local.gpu_tunnel, proxied = true }

    # --- Mail authentication TXT records -------------------------------------
    # Not proxied (TXT cannot be). These are load-bearing: `-all` plus DMARC
    # `p=reject` is what stops anyone spoofing the domain, so they carry the
    # strongest reason to be codified and protected from an accidental delete.
    # tests/records.tftest.hcl asserts their contents.
    spf   = { type = "TXT", name = "@", content = "v=spf1 -all", proxied = false }
    dmarc = { type = "TXT", name = "_dmarc", content = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;", proxied = false }
    # Wildcard DKIM selector. Empty `p=` revokes the key: any DKIM signature for
    # this domain must fail. Keep the empty value -- it is intentional.
    dkim = { type = "TXT", name = "*._domainkey", content = "v=DKIM1; p=", proxied = false }

    # --- CAA: which public CAs may issue for this zone ------------------------
    # Without CAA any CA may issue. These are exactly the four Cloudflare lists for
    # Universal SSL (the edge certificate is Google Trust Services today, and
    # Cloudflare may rotate among the four for operational reasons), each as `issue`
    # and `issuewild` because the Universal certificate covers the apex and `*`.
    # The Origin CA certificate on the VPS is not publicly trusted and is unaffected.
    # `cansignhttpexchanges` is a Cloudflare requirement for Google, not a choice.
    # No `iodef` record: the zone has no MX, so nowhere would receive the report.
    # CAA records are never proxied and carry `data`, not `content`.
    caa_google_issue          = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issue", value = "pki.goog; cansignhttpexchanges=yes" } }
    caa_google_issuewild      = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issuewild", value = "pki.goog; cansignhttpexchanges=yes" } }
    caa_letsencrypt_issue     = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issue", value = "letsencrypt.org" } }
    caa_letsencrypt_issuewild = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issuewild", value = "letsencrypt.org" } }
    caa_sslcom_issue          = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issue", value = "ssl.com" } }
    caa_sslcom_issuewild      = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issuewild", value = "ssl.com" } }
    caa_sectigo_issue         = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issue", value = "sectigo.com" } }
    caa_sectigo_issuewild     = { type = "CAA", name = "@", proxied = false, data = { flags = 0, tag = "issuewild", value = "sectigo.com" } }
  }

  fqdn = {
    for key, record in local.records :
    key => record.name == "@" ? var.root_domain : "${record.name}.${var.root_domain}"
  }
}

resource "cloudflare_dns_record" "record" {
  for_each = local.records

  zone_id = local.zone_id
  name    = local.fqdn[each.key]
  type    = each.value.type
  proxied = each.value.proxied

  # A, CNAME and TXT records are a single `content` string; CAA is structured and
  # goes through `data`. Each record sets exactly one of the two.
  content = lookup(each.value, "content", null)
  data    = lookup(each.value, "data", null)

  # Cloudflare reports TTL 1 ("automatic") for all of these, including the
  # proxied records, so match the live value rather than asserting a custom TTL.
  ttl = 1

  comment = lookup(each.value, "comment", null)

  lifecycle {
    # A mistyped name or content would otherwise plan as destroy + create, i.e.
    # an outage. This makes that fail loudly instead. Note it guards destroy and
    # replace only -- it does not block in-place updates.
    prevent_destroy = true
  }
}
