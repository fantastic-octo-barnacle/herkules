# The Terraform state for this configuration lives in R2, not on a laptop.
#
# Credentials come from the environment only: the S3 backend reads the standard
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY names, and those must hold an R2 API
# token scoped to this bucket alone. They are NOT the backup credentials in
# .env.backup, which stay on the box. See README.md, "State".
#
# The bucket is private and R2 does not implement PutBucketVersioning, so there
# is no undo for a corrupted state object. That is acceptable only while the
# managed scope holds no secrets -- which is exactly why §8 Phase B keeps the
# Access identity-provider and service-token secrets out of Terraform.
#
# R2 needs every skip_* flag below plus use_path_style; Cloudflare's own
# remote-backend page lists them, though that page is still written for the v4
# provider. use_lockfile works because R2 implements conditional PutObject
# (If-None-Match), so no DynamoDB is involved.
terraform {
  backend "s3" {
    bucket = "herkules-tfstate"
    key    = "cloudflare/herkules.dev.tfstate"
    region = "auto" # R2's region; "us-east-1" and "" are aliases

    # The account ID is not a secret -- it is already a GitHub environment
    # variable -- and a backend block cannot interpolate variables.
    endpoints = { s3 = "https://23f9f907180aec40d12869704c713b18.r2.cloudflarestorage.com" }

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    use_lockfile = true
  }
}
