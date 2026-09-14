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
    condition     = !endswith(var.root_domain, ".")
    error_message = "Use the bare apex without a trailing dot, e.g. \"herkules.dev\"."
  }
}

variable "origin_ipv4" {
  description = "The HK VPS. All proxied A records point here. The box has no IPv6, so there are deliberately no AAAA records."
  type        = string
  default     = "124.156.183.221"
}
