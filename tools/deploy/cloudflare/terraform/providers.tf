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
#   TF_VAR_api_token   a token scoped to this zone only:
#                        Zone -> DNS -> Edit        (DNS Read + DNS Write)
#                        Zone -> Zone -> Read       (resolving the zone ID)
#
# It must not carry Workers, R2, or billing permissions. Cloudflare API tokens are
# the supported credential; API keys are legacy.
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
