variable "api_token" {
  description = "Terraform-scoped Cloudflare API token. Set TF_VAR_api_token in the shell; never committed."
  type        = string
  sensitive   = true
}

variable "root_domain" {
  description = "Apex of the zone. Resolves the zone ID and is the suffix for every record name."
  type        = string
  default     = "herkules.dev"

  validation {
    # Lowercase labels, at least one dot, and a letters-only final label. The old
    # check only rejected a trailing dot, so the empty string, "api..example",
    # spaces and uppercase all passed and then reached the zone lookup and the
    # record-name suffix.
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.root_domain))
    error_message = "Use a lowercase apex domain with no trailing dot, e.g. \"herkules.dev\"."
  }
}

variable "origin_ipv4" {
  description = "The HK VPS. All proxied A records point here. The box has no IPv6, so there are deliberately no AAAA records."
  type        = string
  default     = "124.156.183.221"
}
