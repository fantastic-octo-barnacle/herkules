# Pinned to the v5 line. v5 is a rewrite generated from Cloudflare's OpenAPI spec;
# v4 is in maintenance and further 4.x releases are not expected outside security
# fixes. Do not downgrade without re-reading the v5 migration guide.
#
# The CI actions (dflook/terraform-*) install whatever satisfies required_version,
# so this is the single place the Terraform floor is declared.
terraform {
  required_version = ">= 1.7.0" # mock_provider in tests/ arrived in 1.7

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }
}
