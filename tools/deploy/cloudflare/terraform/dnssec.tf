# DNSSEC for the zone. It was enabled by hand and has been active since before this
# directory existed; the DS record is at the registrar. Declaring it here does not
# change it -- the provider's Create is a PATCH of `status`, and "active" is the live
# value -- it puts the drift job's eyes on it, so a dashboard toggle that would turn
# signing off is noticed instead of discovered by resolvers.
#
# `prevent_destroy` guards live behaviour here, and severely: the provider's Delete
# (verified in v5.25.0's `internal/services/zone_dnssec/resource.go`) first sets the
# status to disabled and then deletes the DNSSEC keys. With the DS record still at
# the registrar, every validating resolver would then fail the zone -- an outage for
# every hostname at once.
#
# Only `status` is stated. The multi-signer, presigned and NSEC3 flags are left unset
# so the PATCH does not touch them.

resource "cloudflare_zone_dnssec" "this" {
  zone_id = local.zone_id
  status  = "active"

  lifecycle {
    prevent_destroy = true
  }
}
