output "zone_id" {
  description = "The zone ID resolved from root_domain. Handy for cf-terraforming, which wants it as --zone."
  value       = local.zone_id
}

output "dns_record_ids" {
  description = "Cloudflare record IDs per managed record, after import. Useful for spot-checking that every import block matched something real."
  value       = { for k, r in cloudflare_dns_record.record : k => r.id }
}

output "access_application_ids" {
  description = "Access application IDs per managed application, after import. The applications are imported by these IDs, so they are also the recovery path if imports.tf has to be regenerated."
  value = {
    capability_map = cloudflare_zero_trust_access_application.capability_map.id
    gpu_4090       = cloudflare_zero_trust_access_application.gpu_4090.id
  }
}

output "access_policy_ids" {
  description = "Account-level (reusable) Access policy IDs. The applications reference these by id, so a policy is never duplicated."
  value = {
    herkules_team = cloudflare_zero_trust_access_policy.herkules_team.id
    ai_gateway    = cloudflare_zero_trust_access_policy.ai_gateway.id
  }
}

output "ruleset_ids" {
  description = "Managed zone ruleset IDs, after import. A ruleset imports as zones/<zone_id>/<ruleset_id>, so this is the recovery path if state has to be rebuilt."
  value = {
    redirect = cloudflare_ruleset.redirect.id
  }
}

output "dnssec_ds" {
  description = "The DS record Cloudflare expects at the registrar. Compare against the registrar's DNSSEC page after any key change."
  value       = cloudflare_zone_dnssec.this.ds
}
