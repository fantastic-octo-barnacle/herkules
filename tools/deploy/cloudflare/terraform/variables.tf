variable "api_token" {
  description = "Terraform-scoped Cloudflare API token. Set TF_VAR_api_token in the shell; never committed. README.md, \"Prerequisites\", lists the exact permissions."
  type        = string
  sensitive   = true

  # Ephemeral (Terraform >= 1.10): the value is used only to configure the provider
  # and is never written to the plan file or to state. Without this, a saved plan
  # carries every variable value in clear, the token included.
  ephemeral = true
}

variable "root_domain" {
  description = "Apex of the zone. Resolves the zone ID and is the suffix for every record name."
  type        = string
  default     = "herkules.dev"

  validation {
    # Lowercase labels, at least one dot, a letters-only final label, no trailing
    # dot. Anything else would reach the zone lookup and the record-name suffix.
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.root_domain))
    error_message = "Use a lowercase apex domain with no trailing dot, e.g. \"herkules.dev\"."
  }
}

variable "origin_ipv4" {
  description = "The HK VPS. All proxied A records point here. The box has no IPv6, so there are deliberately no AAAA records."
  type        = string
  default     = "124.156.183.221"

  validation {
    condition     = can(cidrnetmask("${var.origin_ipv4}/32"))
    error_message = "origin_ipv4 must be a dotted-quad IPv4 address."
  }
}

variable "account_id" {
  description = "Cloudflare account that owns the Access applications and policies. An identifier rather than a secret, so it carries a default and CI needs no extra value."
  type        = string
  default     = "23f9f907180aec40d12869704c713b18"

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "Cloudflare account IDs are 32 lowercase hex characters."
  }
}

variable "oidc_idp_id" {
  description = "UUID of the Herkules OIDC identity provider in Zero Trust. Referenced, never managed: its config.client_secret is Sensitive in the schema and would still land in state as plaintext."
  type        = string
  default     = "6c0c04ea-0ae2-4f2a-99f2-dcbc4c23db71"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$", var.oidc_idp_id))
    error_message = "The identity provider ID is a lowercase UUID."
  }
}

variable "service_token_name" {
  description = "Dashboard name of the Access service token the inference gateway presents. Looked up by name so that neither a secret nor an opaque id has to live in this repository."
  type        = string
  default     = "herkules-ai-gateway"

  validation {
    condition     = length(trimspace(var.service_token_name)) > 0
    error_message = "The service token name must not be empty."
  }
}
