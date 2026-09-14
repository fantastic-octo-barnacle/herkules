# Pinned to the v5 line. v5 is a rewrite generated from Cloudflare's OpenAPI spec;
# v4 is in maintenance and further 4.x releases are not expected outside security
# fixes. Do not downgrade without re-reading the v5 migration guide.
#
# The CI actions (dflook/terraform-*) install whatever satisfies required_version,
# so this is the single place the Terraform floor is declared.
terraform {
  # 1.10 is the floor for the S3 backend's `use_lockfile` (backend.tf); the
  # mock_provider in tests/ needs only 1.7, so the lockfile is the binding
  # requirement. Lowering this would let `terraform init` fail on a backend
  # argument the installed version does not recognise.
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }
}
