output "zone_id" {
  description = "The zone ID resolved from root_domain. Handy for cf-terraforming, which wants it as --zone."
  value       = local.zone_id
}

output "dns_record_ids" {
  description = "Cloudflare record IDs per managed record, after import. Useful for spot-checking that every import block matched something real."
  value       = { for k, r in cloudflare_dns_record.record : k => r.id }
}
