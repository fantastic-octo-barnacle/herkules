# The one zone ruleset this zone owns: the `www` -> apex redirect, adopted from the
# live zone on 2026-09-14 (Phase D).
#
# `dns.tf` already manages the `www` record, but the redirect it feeds was invisible
# until now: Cloudflare's "Redirect from WWW to root" dashboard template created both
# the record and this ruleset, so nothing in this repository described the redirect
# and no plan would have noticed it disappearing.
#
# The survey, and why this file is smaller than §8 of docs/cloudflare-terraform.md
# expected:
#
#   `GET /zones/<zone>/rulesets` returned exactly four rulesets. Three are
#   Cloudflare-managed (`kind = "managed"`) -- the DDoS L7 entry point, the
#   Cloudflare Managed Free Ruleset, and the URL normalization ruleset -- and are
#   not ours to declare. The fourth is the `zone`-kind
#   `http_request_dynamic_redirect` entry point below.
#
#   Every other phase §8 named is **empty**. `GET .../phases/<phase>/entrypoint`
#   answers `404` code `10003` ("could not find entrypoint ruleset") for
#   `http_request_cache_settings`, `http_config_settings`, and
#   `http_request_firewall_custom`. So the `ai.herkules.dev` exception that
#   tools/ai/README.md asks for -- bypass caching and interactive browser challenges
#   on the API hostname -- has **no** implementation as zone rules. That is a
#   finding, not a gap to fill here: writing those rules would be new edge behaviour
#   for a public hostname, which is a separate reviewed change rather than part of an
#   adoption pass. See §8 Phase D for the recorded decision.
#
# The rule matches on the **full URI**, and only for `https://www.*`. That is what
# keeps it from competing with `always_use_https` in zone-settings.tf: a plain-HTTP
# `www` request is answered by that zone setting with a 301 to
# `https://www.herkules.dev/...`, and only that second hop reaches this rule.
# Widening the match to the host alone would move the work to a different hop and is
# not the live rule.
#
# `preserve_query_string` is `false` live, and that is correct rather than an
# oversight. The target is computed with `wildcard_replace` over
# `http.request.full_uri`, so the path *and* the query string are already inside the
# captured `*` and arrive at the apex intact. Setting this to `true` -- the obvious
# "fix" -- would append the query string a second time.
# tests/zone-rules.tftest.hcl pins both halves so neither can be changed alone.
#
# `Delete` on this resource really does delete the ruleset (verified in v5.25.0's
# `internal/services/ruleset/resource.go`; note this is the opposite of
# `cloudflare_zone_setting`, whose Delete is a no-op). A destroy here would silently
# drop the redirect for every `www` visitor, so `prevent_destroy` guards live
# behaviour and not merely drift detection.
#
# `ref` is pinned to the live rule's own id. A dashboard-created rule's ref is its
# id, and the provider recreates a rule whose ref changes, so stating it keeps the
# import stable instead of proposing a destroy-and-create.

resource "cloudflare_ruleset" "redirect" {
  zone_id = local.zone_id

  # All four match the live ruleset exactly. The template's name is not descriptive,
  # but renaming it here would be a change rather than an adoption.
  name        = "default"
  description = ""
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [{
    action      = "redirect"
    description = "Redirect from WWW to root [Template]"
    enabled     = true
    ref         = "c77ad7f3798144b291a68b675b5e26e2"

    expression = "(http.request.full_uri wildcard r\"https://www.*\")"

    action_parameters = {
      from_value = {
        preserve_query_string = false
        status_code           = 301

        # `$${1}` is HCL for a literal `${1}`: that is the redirect rule's own
        # wildcard capture, not a Terraform interpolation. Written as `${1}` HCL
        # would try to interpolate it and the plan would fail.
        target_url = {
          expression = "wildcard_replace(http.request.full_uri, r\"https://www.*\", r\"https://$${1}\")"
        }
      }
    }
  }]

  lifecycle {
    prevent_destroy = true
  }
}
