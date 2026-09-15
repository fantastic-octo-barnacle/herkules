# Certificate Transparency alerting for the zone. CAA says which CAs may issue for
# herkules.dev; CT monitoring is how a certificate that got logged anyway is noticed,
# so it is the second half of the same control rather than a duplicate of CAA.
#
# This is the one resource in this directory with a token requirement the others do
# not have: Cloudflare gates it behind `SSL and Certificates` Read/Write, not the
# `Zone Settings` permissions the rest of the configuration uses. Add that permission
# to the Terraform token before applying, or the plan fails to read the resource.
#
# `enabled = true` matches the dashboard's Certificate Transparency Monitoring toggle.
# The recipient list has to be an address that actually receives mail: the zone has no
# MX record and publishes `v=spf1 -all` with DMARC `p=reject`, so a
# `@herkules.dev` address here would silently receive nothing. Cloudflare sends to
# this address when any public CA logs a certificate for the domain. Free on every
# plan.

resource "cloudflare_ct_alerting" "this" {
  zone_id = local.zone_id
  enabled = true
  emails  = ["hxyulin@proton.me"]
}
