# Credentials come from the environment only -- never from a committed file.
#
# We do NOT rely on the provider's default CLOUDFLARE_API_TOKEN lookup. That name
# is already used by tools/deploy/cloudflare/release.mjs for the Workers release
# token, which has entirely different (and non-overlapping) permissions. Sharing
# one name would mean a Terraform run in the same environment silently picks up
# the Workers token, or vice versa. An explicit, distinct variable makes the
# wrong-token mistake impossible to make quietly.
#
# Required environment: TF_VAR_api_token. README.md, "Prerequisites", is the single
# list of the permissions it carries, which of them are granted but unused, and the
# probe matrix that proves everything else is denied. It must never carry Workers,
# R2, or billing permissions, and each phase widened it on purpose.
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
