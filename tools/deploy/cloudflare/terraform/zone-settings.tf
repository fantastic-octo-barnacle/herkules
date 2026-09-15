# Zone-level TLS and security settings, adopted from the live zone on 2026-09-14.
#
# These are the settings behind the "Full (strict)" contract the VPS and the Origin
# CA certificate depend on. This file is what catches a dashboard toggle that would
# silently break it.
#
# The managed set is the ten settings listed below, not all of them. The survey read
# `GET /zones/<zone>/settings` and got 56 settings, 44 of them editable. The rest
# stay hand-set: this pass codifies the contract, it does not take over tuning.
# Deliberately left alone, with the live value the survey recorded:
#   - `http2` (on) -- the API reports `editable = false` on this plan, so a managed
#     resource could not be applied. It is the one candidate §8 named that is out.
#   - `browser_cache_ttl` (14400), `challenge_ttl` (1800), `cache_level`
#     ("aggressive"), `security_level` ("medium"), `development_mode` ("off"),
#     `ciphers` ([] = Cloudflare's defaults), `ipv6` (on), `websockets` (on),
#     `0rtt` (off), `early_hints` (off), and the image features that are not
#     editable on this plan. Caching is owned by Caddy and the asset Workers.
#
# Two values were adopted weaker than the contract wants and hardened afterwards, as
# their own reviewed change (docs/cloudflare-terraform.md §8, Phase C):
#   - `min_tls_version` was `"1.0"` live and is now `"1.2"`. TLS 1.0 and 1.1
#     handshakes are refused at the edge; every current client speaks 1.2 or 1.3.
#   - `security_header` was disabled and HSTS is now sent for six months with
#     `include_subdomains`. Every hostname on the zone is proxied and
#     `always_use_https` already redirects plain HTTP, so nothing served changes;
#     what changes is that browsers refuse to *try* plain HTTP for that long.
#     `preload` stays off: it is a one-way door (removal from the browser lists
#     takes months) and needs a year's max_age, so it is a separate decision.
#     `nosniff` stays off because Caddy already sends X-Content-Type-Options.
#
# `value` is `Dynamic` in provider 5.25 and Terraform needs one element type per
# map, so the settings are grouped by value shape: the nine strings in one
# `for_each`, the single nested object (HSTS) as its own resource. A number-valued
# group would be needed before adopting browser_cache_ttl or challenge_ttl.
#
# `prevent_destroy` here guards a different thing than it does on the records and
# the Access applications. This resource's `Delete` is a **no-op** in the provider
# (verified in v5.25.0's `internal/services/zone_setting/resource.go`), so a
# destroy cannot change the live value -- it only removes the entry from state.
# The guard is what keeps that from happening quietly, which is the drift this file
# exists to catch.

locals {
  string_settings = {
    # The contract itself: encrypt everything, strictly, and never downgrade.
    ssl              = "strict"
    min_tls_version  = "1.2"
    tls_1_3          = "on"
    always_use_https = "on"

    # Everything that keeps a plain-HTTP or TLS-stripping request from landing.
    automatic_https_rewrites = "on"
    opportunistic_encryption = "on"

    # Transport features and the challenge that fronts the origin.
    brotli        = "on"
    http3         = "on"
    browser_check = "on"
  }
}

resource "cloudflare_zone_setting" "string" {
  for_each = local.string_settings

  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = local.zone_id
  setting_id = "security_header"

  # Every field is stated, including `nosniff`, so a dropped attribute cannot fall
  # back to a provider default. See the header above before changing any of them:
  # browsers remember max_age, so shortening it does not take effect for anyone
  # who has already visited.
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 15552000 # six months
      include_subdomains = true
      preload            = false
      nosniff            = false
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
