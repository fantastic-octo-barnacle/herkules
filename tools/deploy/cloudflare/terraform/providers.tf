# Credentials come from the environment only -- never from a committed file.
#
# We do NOT rely on the provider's default CLOUDFLARE_API_TOKEN lookup. That name
# is already used by tools/deploy/cloudflare/release.mjs for the Workers release
# token, which has entirely different (and non-overlapping) permissions. Sharing
# one name would mean a Terraform run in the same environment silently picks up
# the Workers token, or vice versa. An explicit, distinct variable makes the
# wrong-token mistake impossible to make quietly.
#
# Required environment:
#
#   TF_VAR_api_token   a token scoped to this zone for DNS, and to this account for
#                      Access (the Access API is account-scoped, so it cannot be
#                      zone-scoped even though both applications are on the zone):
#                        Zone    -> DNS -> Edit                  (DNS Read + DNS Write)
#                        Zone    -> Zone -> Read                 (resolving the zone ID)
#                        Account -> Access: Apps and Policies -> Edit
#                        Account -> Access: Organizations, Identity Providers,
#                                   and Groups -> Read
#                        Account -> Access: Service Tokens -> Read
#                        Zone    -> Zone Settings -> Edit        (Phase C's ten settings)
#                        Zone    -> Single Redirect -> Edit       (Phase D's redirect rule)
#                        Zone    -> Cache Rules -> Edit           (Phase D survey; unused)
#                        Zone    -> Zone WAF -> Edit              (Phase D survey; unused)
#
#                      The IdP/organization read and the Cache Rules / Zone WAF pair
#                      are granted but not called by this configuration: a traced plan
#                      touches only access/apps, access/policies, and
#                      access/service_tokens, and the Phase D survey proved no ruleset
#                      exists in the cache or custom-WAF phases at all. They are kept
#                      for the org/IdP hardening pass and the ai.herkules.dev proposal
#                      in docs/cloudflare-terraform.md §8; README.md records all three
#                      as the first things to drop at the next rotation.
#
# It must not carry Workers, R2, or billing permissions. Cloudflare API tokens are
# the supported credential; API keys are legacy. Each phase widens the token on
# purpose and README.md carries the probe matrix that proves the rest is denied.
provider "cloudflare" {
  api_token = var.api_token
}

# The zone ID is looked up by name rather than passed in: it is not a secret, and
# Zone Read is already required. One fewer value to carry between shells and CI.
data "cloudflare_zone" "this" {
  filter = {
    name = var.root_domain
  }
}

locals {
  zone_id = data.cloudflare_zone.this.id
}
