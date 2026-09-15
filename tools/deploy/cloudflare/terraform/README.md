# Cloudflare configuration as code

Terraform for the `herkules.dev` zone and the Zero Trust account that fronts it.
**Managed today: twenty DNS records (twelve adopted, eight CAA added), DNSSEC, ten
zone-level TLS and security settings, the `www` → apex redirect rule, and the
Cloudflare Access applications and policies.** That completes the agreed phase order; what is still hand-set, and why,
is under "Deliberately not managed" below, with
[`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md) §8 as the
record of the decisions.

**Status: adopted, on remote state, live in CI.** Twelve records, ten zone settings,
one redirect ruleset, and two Access applications with their two reusable policies
are imported; eight CAA records and the DNSSEC resource were added afterwards. State
lives in the R2 backend (`backend.tf`), and `terraform plan` reports "No changes".
`TERRAFORM_ENABLED` is set, so a PR touching this directory gets a plan comment and a
merge to `main` applies it; the `production` environment holds `TF_VAR_api_token`,
`TF_STATE_ACCESS_KEY_ID` and `TF_STATE_SECRET_ACCESS_KEY`. The zone and the Access
configuration are **live**: read "Adopting the live zone" before re-running any part
of it.

## Scope

Managed here:

| Record                                           | Type  | Points at                                                                         |
| ------------------------------------------------ | ----- | --------------------------------------------------------------------------------- |
| `herkules.dev` (apex)                            | A     | VPS, proxied                                                                      |
| `www`, `bbs`, `status`, `ops`, `ai`, `ai-portal` | A     | VPS, proxied                                                                      |
| `gpu-4090`, `capability-map`                     | CNAME | Cloudflare Tunnel on the GPU host, proxied                                        |
| `herkules.dev` (SPF)                             | TXT   | `v=spf1 -all`                                                                     |
| `_dmarc`                                         | TXT   | `v=DMARC1; p=reject; sp=reject; ...`                                              |
| `*._domainkey`                                   | TXT   | `v=DKIM1; p=` (empty key, intentional)                                            |
| `herkules.dev` (CAA, eight records)              | CAA   | `issue` + `issuewild` for `pki.goog`, `letsencrypt.org`, `ssl.com`, `sectigo.com` |

The CAA set is exactly the four CAs Cloudflare lists for Universal SSL (the edge
certificate is Google Trust Services today; Cloudflare may rotate among the four).
Both tags are needed because the Universal certificate covers the apex and `*`. There
is no `iodef` record because the zone has no MX and nothing would receive the report.

DNSSEC is declared in `dnssec.tf` as `status = "active"`. It was enabled by hand and
the DS record is at the registrar; the resource exists so the drift job notices if
signing is switched off. Its `Delete` disables DNSSEC and removes the keys, which
with the DS still published is an outage for every hostname, so `prevent_destroy`
there is not optional.

Access objects, adopted 2026-09-14 and described in `access.tf`:

| Object              | Kind            | Where it applies                                                                                |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `Herkules team`     | reusable policy | attached to `Capability Map` at precedence 1                                                    |
| `AI Gateway only`   | reusable policy | attached to `Herkules GPU 4090` at precedence 1                                                 |
| `Capability Map`    | self-hosted app | `capability-map.herkules.dev`, OIDC-only, 24h sessions, HttpOnly + binding cookie, SameSite=lax |
| `Herkules GPU 4090` | self-hosted app | `gpu-4090.herkules.dev`, service-token only (no login page), HttpOnly, no binding cookie        |

Zone settings, adopted 2026-09-14 and described in `zone-settings.tf`:

| Setting                                                                    | Live value | Why it is here                     |
| -------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| `ssl`                                                                      | `"strict"` | the Origin CA contract             |
| `min_tls_version`                                                          | `"1.2"`    | the floor; 1.0 and 1.1 are refused |
| `tls_1_3`                                                                  | `"on"`     | keep TLS 1.3 offered               |
| `always_use_https`, `automatic_https_rewrites`, `opportunistic_encryption` | `"on"`     | no plain-HTTP or mixed content     |
| `brotli`, `http3`, `browser_check`                                         | `"on"`     | transport and origin challenge     |
| `security_header` (HSTS)                                                   | 6 months   | with subdomains; preload off       |

Zone rules, adopted 2026-09-14 and described in `zone-rules.tf`:

| Ruleset                         | Phase                           | What it does                                       |
| ------------------------------- | ------------------------------- | -------------------------------------------------- |
| `default` (one `redirect` rule) | `http_request_dynamic_redirect` | `https://www.*` → apex, `301`, path and query kept |

That is the **only** user-owned (`kind = "zone"`) ruleset on the zone. The other
three in the list are Cloudflare's, and the cache, configuration and custom-WAF
phases have no entry point ruleset at all — so the redirect is the whole of Phase D's
adoptable surface.

Deliberately not managed here, and why:

- **SOA / NS records.** Cloudflare owns them; managing them risks the zone's
  delegation for no benefit.
- **The other zone settings.** 56 exist and 44 are editable; the ten above are the
  contract, not the tuning. Left hand-set: `browser_cache_ttl`, `challenge_ttl`,
  `cache_level`, `security_level`, `development_mode`, `ipv6`, `websockets`,
  `0rtt`, `early_hints` and the image/performance features that are not editable
  on this plan. `http2` is not editable at all, so it cannot be managed. See
  `zone-settings.tf` for the full list with the values read live.
- **`ciphers`.** The API reports it editable and the zone-hardening pass meant to
  pin Cloudflare's "modern" list once the floor was 1.2, but restricting cipher
  suites at the zone level needs an Advanced Certificate Manager subscription. On
  the current plan the setting stays `[]` (Cloudflare's defaults). Adopt it as a
  list-valued group if ACM is ever bought.
- **Cloudflare-managed rulesets.** Three appear in the zone's ruleset list — the DDoS
  L7 entry point, the Cloudflare Managed Free Ruleset, and the URL normalization
  ruleset — all `kind = "managed"`. They are Cloudflare's to version, so nothing here
  declares them.
- **The `ai.herkules.dev` cache and challenge exception.** `tools/ai/README.md` asks
  for caching and interactive browser challenges to be bypassed on the API hostname,
  and the Phase D survey proved that **no zone rule implements it**:
  `http_request_cache_settings`, `http_config_settings` and
  `http_request_firewall_custom` each answer `404` code `10003` ("could not find
  entrypoint ruleset"), and the zone's ruleset list holds nothing in those phases.
  Writing those rules would be new edge behaviour in front of a public hostname, so
  it is proposed as a separate change rather than folded into an adoption pass. §8
  Phase D records the finding and the options.
- **The Herkules OIDC identity provider and the `herkules-ai-gateway` service
  token.** Both carry a `client_secret` that is marked Sensitive in the provider
  schema but still lands in state as **plaintext**, and both must already exist in
  the auth service's `.env.auth` and on the GPU host. Managing them would copy a
  secret into the R2 state bucket without removing a manual step. The applications
  reference the IdP by id (a variable) and the token through a **data source**,
  which exposes no secret. There is also a provider bug here: the OTP login method
  produces a recurring diff when managed
  ([cloudflare/terraform-provider-cloudflare#5693](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5693)).
- **The Zero Trust organization.** `cloudflare_zero_trust_organization` cannot be
  imported at all, so `is_ui_read_only` stays a manual dashboard step.
- **R2.** Deferred, with the order agreed in
  [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md) §8.
- **Worker uploads and the five Worker routes.** Permanently out of scope —
  `../release.mjs` owns them and derives their content from immutable image
  digests at release time. Two tools must never own the same resource. CI greps
  for `cloudflare_workers_*`, `cloudflare_origin_ca_certificate`, and
  `cloudflare_account_token` here and fails if one appears.
- **Access for the VPS-hosted hostnames.** There is none to manage: no Access
  application matches them. `ai-portal.herkules.dev` in particular answers with its
  own `/dashboard` redirect rather than an Access challenge, so the portal's
  authentication is New API's, not Zero Trust's. Putting it behind Access is a
  deliberate future change, not an adoption.

## What is ours and what is not

The only hand-written content is `dns.tf` (the record set), the provider and
variable declarations, and the invariants in `tests/`. Everything mechanical is
delegated:

| Job                                    | Done by                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Generating import blocks from the zone | [`cf-terraforming`](https://github.com/cloudflare/cf-terraforming), Cloudflare's own tool |
| Format, schema validation, invariants  | `terraform fmt`, `terraform validate`, `terraform test`                                   |
| Plan on PR, apply on merge             | [`dflook/terraform-github-actions`](https://github.com/dflook/terraform-github-actions)   |
| Provider version bumps                 | Dependabot (`.github/dependabot.yml`)                                                     |

## Prerequisites

1. **A dedicated API token.** Not the Workers release token. In the Cloudflare
   dashboard create a token with exactly:
   - `Zone` → `DNS` → **Edit**
   - `Zone` → `Zone` → **Read**
   - `Zone` → `Zone Settings` → **Edit**
   - `Zone` → `Single Redirect` → **Edit**
   - `Zone` → `Cache Rules` → **Edit**
   - `Zone` → `Zone WAF` → **Edit**
   - `Account` → `Access: Apps and Policies` → **Edit**
   - `Account` → `Access: Organizations, Identity Providers, and Groups` → **Read**
   - `Account` → `Access: Service Tokens` → **Read**

   Narrow the zone permissions to the `herkules.dev` zone. The Access permissions
   cannot be zone-scoped — Cloudflare's Access API is account-level, even though
   both managed applications sit on this zone — so they are scoped to this account
   only. It needs no Workers, R2, or billing permissions.

   `Cache Rules` and `Zone WAF` were added for Phase D and turned out **not to be
   needed**: the survey found no ruleset in either phase, and the redirect needs only
   `Single Redirect`. They are listed because they are granted today and the probe
   table below pins the result. Drop them, with the Access IdP/organization read,
   when next rotating the token. `Config Rules` is deliberately **not** granted —
   the zone's ruleset list is readable without it, which is how the survey
   established that `http_config_settings` is empty.

   **A permission edit is not immediately effective.** After adding `Zone Settings`,
   `GET /zones/<zone>/settings` starts answering `200` while individual reads of some
   settings still answer `403` with code `10000` for several minutes, and the same
   read can flip back and forth in between. It is propagation, not a wrong
   permission: re-probe the setting that failed a few minutes later before changing
   anything. Observed on 2026-09-14, when a plan failed on `always_use_https`,
   `automatic_https_rewrites`, and `brotli` and all three answered `200` shortly
   after. The token value itself does not change when permissions are edited, so
   the `production` secret never needs re-pasting for this.

   The `Organizations, Identity Providers, and Groups` read is **not exercised by
   the current configuration**: a traced plan calls only `access/apps`,
   `access/policies`, and `access/service_tokens`, because the IdP is referenced by
   id and the organization is not managed. It is listed because it is granted today
   and the probe table below pins the result. Drop it when next rotating the token
   (a hand edit — this repository has no `API Tokens` write scope) unless the
   org/IdP hardening pass in [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md)
   §8 has started by then.

   This is a **separate variable name** from the release job's
   `CLOUDFLARE_API_TOKEN` on purpose: if both used the same name, a Terraform run
   in a shell that also deploys Workers would silently pick up the wrong token.

   ```sh
   export TF_VAR_api_token=<the terraform-scoped token>
   ```

   That is the only value to carry. The zone ID is resolved from the domain name
   at plan time (`providers.tf`), which is why the token needs Zone Read.

   To keep it out of shell history, use the same out-of-checkout convention as
   [`save-access-token.py`](../../../ai/save-access-token.py):

   ```sh
   mkdir -p -m 700 ~/.config/herkules/terraform
   read -rs TF_TOKEN   # paste the token; it is not echoed
   printf '%s' "$TF_TOKEN" > ~/.config/herkules/terraform/api-token
   chmod 600 ~/.config/herkules/terraform/api-token
   export TF_VAR_api_token="$(cat ~/.config/herkules/terraform/api-token)"
   ```

   **Check the scope after creating or rotating it.** DNS and Access should work and
   everything else should be denied — each later phase widens the token on purpose,
   so a 200 where a 403 is expected means the token is too broad:

   | Endpoint                                               | Expected                                                                                                                                                                                  |
   | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `GET /zones/<zone>/dns_records`                        | `200`                                                                                                                                                                                     |
   | `GET /accounts/<account>/access/apps`                  | `200` — Phase B                                                                                                                                                                           |
   | `GET /accounts/<account>/access/identity_providers`    | `200` — granted, but unused (see above)                                                                                                                                                   |
   | `GET /accounts/<account>/access/service_tokens`        | `200` — Phase B                                                                                                                                                                           |
   | `GET /accounts/<account>/access/organizations`         | `200` — granted, but unused (see above)                                                                                                                                                   |
   | `GET /zones/<zone>/settings`                           | `200` — Phase C                                                                                                                                                                           |
   | `GET /zones/<zone>/settings/<setting_id>`              | `200` — Phase C                                                                                                                                                                           |
   | `GET /zones/<zone>/rulesets`                           | `200` — Phase D                                                                                                                                                                           |
   | `GET /zones/<zone>/rulesets/phases/<phase>/entrypoint` | `200` for `http_request_dynamic_redirect`; `404` code `10003` for `http_request_cache_settings`, `http_config_settings` and `http_request_firewall_custom`, which have no ruleset to read |
   | `GET /accounts/<account>/rulesets`                     | `403` — account rulesets are never granted                                                                                                                                                |
   | `GET /zones/<zone>/workers/routes`                     | `403` — `release.mjs` owns these                                                                                                                                                          |
   | `GET /accounts/<account>/workers/scripts`              | `403` — `release.mjs` owns these                                                                                                                                                          |
   | `GET /accounts/<account>/r2/buckets`                   | `403` — never granted                                                                                                                                                                     |
   | `GET /zones/<other-zone>/dns_records`                  | `403` — every other zone in the account                                                                                                                                                   |

   Three notes from the 2026-09-14 re-verification. `GET /zones` with no filter lists
   **all five** zones in the account, while `dns_records` and `settings` on the other
   four are `403`: the zone list is metadata, not reach, and is worth knowing before
   a config mistake is assumed to be contained by the token. `origin_ca_certificates`
   answers `400` rather than `403` (an unimplemented route), which is inconclusive
   either way; Origin CA stays never-granted by policy. And the settings rows are the
   ones to re-probe rather than trust immediately after granting the permission —
   see the propagation note above.

   One more distinction the ruleset rows make: `GET /zones/<zone>/rulesets` answers
   `200` and lists **four** rulesets, three of which are Cloudflare's own
   (`kind = "managed"`). Being able to read a ruleset is not a claim to own it, and
   the list endpoint is the cheap way to prove which phases even have one before
   writing any resource.

   Verified on 2026-09-14 against the production token, after the Phase D widening.

2. **Terraform >= 1.10** and **cf-terraforming**:

   ```sh
   brew install hashicorp/tap/terraform cloudflare/cloudflare/cf-terraforming
   ```

   OpenTofu also works with this HCL, and the CI actions have `tofu-*` twins.

## Adopting the live zone

This was done once, on 2026-09-14; the procedure below is how to do it again if
state is ever lost or a second zone is added.

The import blocks are generated from the live zone by Cloudflare's own tool
rather than hand-copied, so the IDs in Git are provably the ones Cloudflare
holds. `cf-terraforming` reads the provider schema from an initialised working
directory, so init first.

`terraform init` initializes the R2 backend (`backend.tf`) and therefore needs the
state credentials; `cf-terraforming` reads the initialized directory, so it inherits
that requirement.

```sh
cd tools/deploy/cloudflare/terraform

export AWS_ACCESS_KEY_ID="$(cat ~/.config/herkules/terraform/r2-access-key-id)"
export AWS_SECRET_ACCESS_KEY="$(cat ~/.config/herkules/terraform/r2-secret-access-key)"

terraform init

# 1. The zone ID. The dashboard shows it on the zone's Overview page, or read it
#    from the API with the same token. Hand curl the header through a config file
#    rather than -H: a token in argv is readable by any process on the machine.
hdr=$(mktemp); chmod 600 "$hdr"
cat > "$hdr" <<EOF
header = "Authorization: Bearer $TF_VAR_api_token"
EOF
ZONE_ID=$(curl -fsS -K "$hdr" "https://api.cloudflare.com/client/v4/zones?name=herkules.dev" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
rm -f "$hdr"
#    `terraform console` cannot do this step: with an empty state it evaluates the
#    data source as "(known after apply)" instead of reading it, so it returns no
#    ID at all.

# 2. Generate the import blocks. Read-only against Cloudflare. cf-terraforming
#    reads the token from the environment, keeping it out of argv. The name is the
#    Workers release token's, which is exactly the confusion providers.tf warns
#    about -- it is safe here only because this command is read-only and the
#    provider itself takes api_token from TF_VAR_api_token.
CLOUDFLARE_API_TOKEN="$TF_VAR_api_token" cf-terraforming import \
  --resource-type cloudflare_dns_record --zone "$ZONE_ID" \
  --modern-import-block \
  --terraform-binary-path "$(which terraform)" --terraform-install-path . \
  > imports.tf
```

`cf-terraforming` names every address `cloudflare_dns_record.terraform_managed_resource_<id>`,
and the import block alone does not say which record an ID belongs to. To see
that mapping, generate the live HCL to a scratch file and read it side by side:

```sh
CLOUDFLARE_API_TOKEN="$TF_VAR_api_token" cf-terraforming generate \
  --resource-type cloudflare_dns_record --zone "$ZONE_ID" \
  --terraform-binary-path "$(which terraform)" --terraform-install-path . \
  > "$TMPDIR/live.tf"
```

Then edit each `to =` line in `imports.tf` to the matching key in `dns.tf`, for
example `cloudflare_dns_record.record["apex"]`. Twelve lines, once. Do not commit
`live.tf`; `dns.tf` stays the reviewed source of truth.

```sh
# 3. Read the plan before doing anything else. See below for what it must say.
terraform plan
```

`terraform plan` with the import blocks adopts the existing records **and** reports
any difference between `dns.tf` and reality. Read it carefully:

- **Expected:** `12 to import, 0 to change, 0 to destroy`.
- **Not acceptable:** anything under "will be updated in-place" or "must be
  replaced". A proposed change at this point is a bug in `dns.tf`, not something
  to apply — fix the config until the only actions are imports.
- **One known exception, hit on the 2026-09-14 adoption:** the three TXT records
  also planned an in-place update. Dashboard-created records are returned by the
  API as `"\"v=spf1 -all\""`, while `dns.tf` declares the canonical unquoted
  value. The two are the same record — the quotes are API presentation, and
  `dig +short TXT herkules.dev` shows the unquoted value being served. An
  unquoted API write reads back unquoted, so applying it converged: the next plan
  reported "No changes" and the served values were byte-identical before and
  after. Confirm that with `dig` before and after rather than assuming it, and
  treat every other in-place update as a config bug.

Common causes of a proposed change:

- A record's `content`, `proxied`, or `comment` differs from what's in the zone.
- `private_routing` is set on a live record (we deliberately do not manage it; if
  a plan wants to change it, that field must be left unset).
- TTL differs (we assert `1`, Cloudflare's "automatic", which is what the zone
  export showed for every record).
- An import block still points at a `terraform_managed_resource_*` address that
  `dns.tf` does not declare (step 2's rename was missed).

Only when the plan shows imports and nothing else:

```sh
terraform apply
```

Then run `terraform plan` once more. **That** run must report **"No changes."**
That second plan is the real proof that `dns.tf` matches the live zone, and it is
the thing to paste into a pull request.

**Delete `imports.tf` once the import has succeeded.** It is needed for the first
apply only, and leaving it in place **breaks CI**: `terraform test` runs the
configuration under `mock_provider`, and Terraform refuses to import from a mock
provider (`Cannot import resources from mock providers`), so the credential-free
`terraform test` check fails. This was corrected on 2026-09-14, when the file was
removed after the twelve records were adopted. The IDs remain recoverable from
state with `terraform output dns_record_ids`, and the file itself can be
regenerated at any time with `cf-terraforming import` as above.

### The Access pass (done 2026-09-14)

Same procedure, two provider differences. Access is **account-scoped**, and
`cf-terraforming` treats `--account` and `--zone` as mutually exclusive, so a run
for Access carries only the account:

```sh
ACCOUNT_ID=23f9f907180aec40d12869704c713b18

CLOUDFLARE_API_TOKEN="$TF_VAR_api_token" cf-terraforming generate \
  --resource-type cloudflare_zero_trust_access_application,cloudflare_zero_trust_access_policy \
  --account "$ACCOUNT_ID" \
  --terraform-binary-path "$(which terraform)" --terraform-install-path . \
  > "$TMPDIR/live-access.tf"
```

Read that file; do not copy it. It emits every attribute the API returns, including
read-only ones, and emits both `domain` and `destinations` **and** the deprecated
`self_hosted_domains`, so it looks importable while `access.tf` is the reviewed
shape. Four fields decide whether the plan is empty:

- `self_hosted_domains` stays **unset**; `destinations` supersedes it.
- `connection_rules = { rdp = {} }` must be present on each policy. Cloudflare
  reports it for account-level policies with no connection restrictions, and
  omitting it makes every plan propose an in-place update.
- Every cookie flag must be stated. At adoption both applications had
  `http_only_cookie_attribute = false` while the provider defaults it to `true`, so
  omitting it would have silently changed the cookie Access hands the origin; the
  Access hardening pass later set it to `true` on both, and turned on the binding
  cookie and `same_site_cookie_attribute = "lax"` on `capability-map` only.
  `enable_binding_cookie`, `options_preflight_bypass`, and
  `auto_redirect_to_identity = false` on the service-token application are the same
  trap in the other direction.
- `allowed_idps` is left unset on the service-token application: the API reports an
  empty list, and an explicit `[]` plans as a change against it.

Then the four import blocks. Note the two id shapes — policies import as
`<account_id>/<policy_id>`, applications as `accounts/<account_id>/<app_id>`:

```hcl
import {
  to = cloudflare_zero_trust_access_policy.herkules_team
  id = "<account_id>/<policy_id>"
}

import {
  to = cloudflare_zero_trust_access_application.capability_map
  id = "accounts/<account_id>/<app_id>"
}
```

`terraform plan` must read **`4 to import, 0 to add, 0 to change, 0 to destroy`**.
Anything else is a change to a live authentication path: reconcile the config
instead of applying. After the apply, `terraform output access_application_ids` and
`access_policy_ids` print the adopted IDs, and the follow-up plan must be empty.

### The settings pass (done 2026-09-14)

`cf-terraforming` is the wrong tool here — it generates one resource per setting with
every read-only attribute, and the import blocks are the only part worth having. Read
the live values first instead, with the same config file trick as above so the token
never reaches argv:

```sh
ZONE_ID=67cb36267fed15436458bf4dfdfbaf60

# The whole list, values and all. This is the survey: it shows the value *type*,
# which decides how the resources have to be grouped, and `editable`, which decides
# whether a setting can be managed at all.
curl -s -K "$TMPDIR/cf-curlcfg" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings" \
  | jq -r '.result[] | select(.editable) | "\(.id)\t\(.value|tojson)"' | column -t
```

Then the ten import blocks, one per managed setting, `to` a `for_each` instance where
it is one:

```hcl
import {
  to = cloudflare_zone_setting.string["ssl"]
  id = "<zone_id>/ssl"
}

import {
  to = cloudflare_zone_setting.hsts
  id = "<zone_id>/security_header"
}
```

`terraform plan` must read **`10 to import, 0 to add, 0 to change, 0 to destroy`**.
Three things about this resource make that gate the whole exercise:

- `value` is **Dynamic**, and Terraform needs one element type per map, so settings
  are grouped by value shape: the nine strings share one `for_each`, the HSTS object
  is its own resource. Adopting `browser_cache_ttl` or `challenge_ttl` means adding a
  number-valued group; `ciphers` would be a list-valued one.
- `editable` is a computed, plan-dependent field. The survey is what catches the ones
  that cannot be managed: `http2`, `mirage`, `polish`, `webp`, and `preload`-era
  performance settings are `editable: false` on this plan, so a resource for them
  would fail at apply rather than at plan.
- `Delete` for this resource is a **no-op** in provider 5.25.0 (read
  `internal/services/zone_setting/resource.go` rather than assuming): destroying one
  only removes it from state and leaves the live value alone. `prevent_destroy` is
  therefore guarding the drift _detection_, not the value.

### The zone-rules pass (done 2026-09-14)

`cf-terraforming` is the wrong tool here as well: run against the zone it would emit
all four rulesets, three of which are Cloudflare's. Read the live objects instead,
with the same config-file trick so the token never reaches argv:

```sh
ZONE_ID=67cb36267fed15436458bf4dfdfbaf60

# What phases even have a ruleset, and which of them are ours.
curl -s -K "$TMPDIR/cf-curlcfg" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets?per_page=50" \
  | jq -r '.result[] | "\(.kind)\t\(.phase)\t\(.id)"' | column -t

# The list response omits rule bodies -- it reports `rules: []` even for a ruleset
# that has one -- so the entry point is where the actual rule is.
curl -s -K "$TMPDIR/cf-curlcfg" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
  | jq '.result'
```

Then the one import block:

```hcl
import {
  to = cloudflare_ruleset.redirect
  id = "zones/<zone_id>/<ruleset_id>"
}
```

`terraform plan` must read **`1 to import, 0 to add, 0 to change, 0 to destroy`**.
Before the import the same plan reads `1 to add`, and the provider's dry run warns
`exceeded maximum number of zone rulesets for phase http_request_dynamic_redirect` —
a useful confirmation that the phase is already occupied and a create would fail,
rather than a warning to work around. After the apply, `terraform output ruleset_ids`
prints the adopted id and the follow-up plan must be empty.

Four things about this resource decide whether that plan converges:

- **The import id carries a discriminator**: `zones/<zone_id>/<ruleset_id>`, not
  `<zone_id>/<ruleset_id>`. The provider parses a `zones/` or `accounts/` segment
  first and rejects the shorter form.
- `rules` is a **list attribute, not a block**, so the rule is written `rules = [{ ... }]`.
- **`ref` is pinned to the live rule's id.** A dashboard-created rule uses its own id
  as its ref, and the provider replaces a rule whose ref changes, so stating it keeps
  the import from proposing a destroy-and-create.
- **The target expression contains a literal `${1}`** — the redirect rule's own
  wildcard capture, not a Terraform interpolation. In HCL it must be written `$${1}`;
  the unescaped form fails the plan.

Also unlike `cloudflare_zone_setting`, `Delete` here really does delete the ruleset
(read `internal/services/ruleset/resource.go`): `prevent_destroy` guards live
behaviour, because a destroy would drop the redirect for every `www` visitor.

Two more facts the survey settled, both recorded in §8:

- The `ai.herkules.dev` cache and challenge exception **is not implemented anywhere**:
  the cache, configuration and custom-WAF phases answer `404` code `10003`, and the
  zone's ruleset list holds nothing in those phases. There was nothing to adopt.
- `http_request_redirect` — bulk redirects — is **not a zone-level phase**; the API
  answers `phase "http_request_redirect" not allowed at zone level`. Bulk redirects
  live on the account, where this token is and stays `403`.

## Credential-free checks

The `terraform` job in `.github/workflows/ci.yml` runs on every PR, with no
token and no network access to Cloudflare:

- `terraform fmt -check`
- `terraform validate`
- `terraform test` — five files under a mocked provider. `tests/records.tftest.hcl`
  pins the record set, the mail TXT contents, that every A record is the proxied
  VPS, that there are no AAAA records, the automatic TTL, and that CAA allows both
  tags for each of the four Universal SSL CAs. `tests/dnssec.tftest.hcl` pins
  `status = "active"`.
  `tests/access.tftest.hcl` pins the Access set, that every application reaches its
  destination through `destinations`, that each attached policy is a _reference_
  with an id rather than an inline copy, that `capability-map` stays OIDC-only, and
  that `gpu-4090` stays service-token-only. `tests/zone-settings.tftest.hcl` pins the
  ten managed settings, that `ssl` is `strict`, that TLS 1.3 and the HTTPS-rewrite
  family stay on, that `min_tls_version` stays at or above 1.2, that `http2` is
  absent, and that HSTS stays enabled for every subdomain with at least a 30-day
  `max_age` and `preload` off.
  `tests/zone-rules.tftest.hcl` pins the redirect: one zone-kind ruleset in the one
  populated phase, HTTPS-only matching on the full URI, a target that still carries
  the path and query through `wildcard_replace` + `${1}`, and
  `preserve_query_string = false`. Each file also pins a well-formed mocked zone id,
  because `cloudflare_ruleset.zone_id` is validated as 32 hexadecimal characters
  while a mocked data source returns a short random string — and because every test
  file plans the whole configuration, one unplannable resource fails all of them.
- an ownership check that no `cloudflare_workers_*`, `cloudflare_origin_ca_certificate`,
  or `cloudflare_account_token` resource has crept in, and that neither
  `cloudflare_zero_trust_access_identity_provider` nor
  `cloudflare_zero_trust_access_service_token` is declared as a **resource** — the
  data source for the service token is expected, a resource would put a
  `client_secret` in state. It is not a plain `grep`: each `*.tf` file is stripped of
  block comments and flattened to one line first, because HCL accepts a resource
  whose keyword and type label are separated by a comment, including a multi-line
  one, and a line-based match reads straight past that. A `*.tf.json` file is
  rejected outright for the same reason — JSON syntax is legal to Terraform and
  invisible to these patterns.

Run the same locally with `terraform fmt -check -recursive && terraform validate && terraform test`.

## Plans and applies in CI

`.github/workflows/terraform.yml` is gated on the repository variable
`TERRAFORM_ENABLED`, which is set: a PR touching this directory gets its plan posted
as a comment by `dflook/terraform-plan`; the merge to main runs
`dflook/terraform-apply`, which re-plans and refuses if the result differs from the
plan that was commented and approved. The plan file never leaves the runner. It does
not hold the token — `api_token` is an ephemeral variable, used to configure the
provider and written to neither the plan nor state — but it does hold every other
variable value and the full resource diff. Unsetting the variable pauses the
workflow; the credential-free checks in `ci.yml` keep running regardless.

A weekly scheduled run generates the same plan without a comment and **fails the
workflow when the plan is non-empty**, so a hand-made dashboard change is noticed
instead of silently diverging from this directory.

## Before you touch the tunnel CNAMEs

`gpu-4090` and `capability-map` point at `aa133e92-...cfargotunnel.com`. These are
**plain DNS records** here. If the Cloudflare Tunnel is ever configured to manage
its own DNS records (for example by adopting `cloudflare_zero_trust_tunnel_cloudflared_config`),
the tunnel and this file will both try to own the same records and fight. Decide
which one owns them before doing that, and remove them from one side.

## The `www` record and its redirect are one thing

`www` was created automatically by Cloudflare's **Redirect Rule** template, which is
also what created the zone ruleset behind it (the record's comment still says so, and
we preserve that comment). Both halves are managed now — the record in `dns.tf`, the
rule in `zone-rules.tf` — so the pair cannot drift apart quietly any more. They are
still dependent on each other in one direction: deleting the record would leave the
rule matching a hostname that no longer resolves. `prevent_destroy` on both is the
guard, on the record because a mistyped name plans as destroy + create, and on the
rule because its `Delete` really deletes.

## After the first apply

Verify the real contract, exactly as the deploy runbook prescribes:

```sh
curl -fsS https://herkules.dev/auth/healthz
curl -fsS https://herkules.dev/.well-known/oauth-authorization-server/auth | head -c 300
curl -fsS https://herkules.dev/ | head -c 200
curl -sI https://herkules.dev/mcp/bbs | grep -i www-authenticate
```

Also confirm mail authentication TXT records survived, since losing them lets
anyone spoof the domain:

```sh
dig +short TXT herkules.dev
dig +short TXT _dmarc.herkules.dev
```

And the zone-level DNS guards. CAA must list all four CAs with both tags, or the
next Universal SSL renewal can fail if Cloudflare rotates to a CA that is missing;
DNSSEC must still validate, or the zone stops resolving for validating resolvers.

```sh
# Eight matches: issue + issuewild for each CA. Cloudflare may serve extra CAA lines
# of its own alongside these, so check for the four CAs, not for an exact count.
dig +short CAA herkules.dev | grep -cE 'issue(wild)? "(pki\.goog|letsencrypt\.org|ssl\.com|sectigo\.com)'
dig +dnssec +short A herkules.dev | grep -c RRSIG   # at least 1
delv @1.1.1.1 herkules.dev A | head -1        # "; fully validated"
```

And the Certificate Transparency guard, which is the other half of CAA: CAA says
which CAs may issue for the zone, CT alerting is how a certificate logged anyway is
noticed.

```sh
# enabled must be true and the recipient list non-empty.
terraform state show cloudflare_ct_alerting.this
```

Note the permission it needs. `zone-ct.tf` is the only resource here behind
Cloudflare's **SSL and Certificates** Read/Write, not the `Zone Settings` and DNS
permissions everything else uses, so the token carries that scope too.

## Hand-set, by design

One guard on this zone is a dashboard toggle with no Terraform resource, so it is
recorded here instead:

- **The registrar's DS record.** Terraform manages Cloudflare's half of DNSSEC; the
  registrar's half is the DS record, and `terraform output dnssec_ds` prints what it
  should be.

CAA, DNSSEC and CT alerting used to be on the hand-set list as well. All three are
Terraform-managed now, so a change to any of them is drift rather than a note.

### Zero Trust settings that stay hand-set

The Access hardening pass (2026-09-15) changed the cookie flags in `access.tf`. The
rest of the list in `docs/cloudflare-terraform.md` §8 is either a dashboard setting
the Terraform token cannot write, or a decision that needs an owner. Each is
recorded here so it is a choice and not an oversight:

- **The one-time PIN identity provider.** It exists, unnamed, and no application
  offers it: `capability-map` allows only the OIDC provider and `gpu-4090` has no
  login page. It is reachable only from the App Launcher sign-in. Deleting it closes
  that path; keeping it is the break-glass route if the OIDC provider is ever
  broken, since re-adding OTP by hand is the first step of recovery. If it is
  deleted, delete it in the dashboard (Zero Trust → Settings → Authentication) and
  note the date here.
- **Organization `session_duration`.** Unset, so Cloudflare's default applies. The
  applications already cap their own sessions at 24h; set the organization value
  only if a shorter global ceiling is wanted.
- **Organization `is_ui_read_only`.** Off. Turning it on stops dashboard edits to
  everything Zero Trust, including the identity provider and service token that
  are deliberately hand-managed, so it trades dashboard drift for API-only edits of
  those two. Not recommended until they are either managed here or never expected
  to change. Managing the organization from this directory would need the token
  widened to `Access: Organizations, Identity Providers, and Groups` → **Edit**.
- **Narrowing the `Herkules team` policy.** The rule is "anyone the Herkules OIDC
  provider signs in", which is exactly the auth service's registration policy. A
  narrower rule needs a claim the provider does not send today (a group or role)
  or an email list, which would go stale. Leave it unless the auth service grows
  a role claim.
- **`ai-portal.herkules.dev` behind Access.** Would put an OIDC login in front of
  the portal's own OIDC login for every user, and is only meaningful once the VPS
  refuses traffic that did not come through Cloudflare, because unlike the two
  tunnel-hosted applications the portal's origin is reachable by IP. Decide the
  origin lockdown first.

And the Access contract, which is what an adoption of `access.tf` can actually
break. Capture these **before** an Access apply as well as after — the point is that
they are unchanged:

```sh
# Identity-protected application: an anonymous request is challenged and lands on
# the team's Cloudflare Access login page.
curl -sI https://capability-map.herkules.dev/ | grep -iE '^(HTTP|location)'

# Service-token application: an anonymous request is refused, not redirected.
curl -s -o /dev/null -w '%{http_code}\n' https://gpu-4090.herkules.dev/

# The portal is NOT behind Access: this answers with the portal's own redirect.
# A GET, not a HEAD: this host answers HEAD with 404 and a bodyless 302 with GET.
curl -s -o /dev/null -D - https://ai-portal.herkules.dev/ | grep -iE '^(HTTP|location)'
```

Expected on 2026-09-14: `302` to `hxyulin.cloudflareaccess.com/cdn-cgi/access/login/capability-map.herkules.dev`,
`403`, and a `302` to `https://ai-portal.herkules.dev/dashboard` respectively. A
`302` on the second line, or an Access challenge on the third, means the adoption
changed which hostnames Zero Trust protects. The first two lines answer a HEAD and a
GET identically — only the portal distinguishes them, which is why its line is
written as a GET and the other two are not.

And the TLS contract, which is what `zone-settings.tf` can break. Same rule: capture
these **before** the apply as well as after, and compare:

```sh
# The zone still serves, and plain HTTP still redirects rather than serving.
curl -s -o /dev/null -w 'apex: %{http_code}\n' https://herkules.dev/
curl -sI http://herkules.dev/ | grep -iE '^(HTTP|location)'

# HSTS is sent for six months with includeSubDomains and without preload. A
# missing header means something disabled it; a `preload` token means someone
# took the one-way door without the review it needs.
curl -sI https://herkules.dev/ | grep -i strict-transport-security

# TLS 1.2 and 1.3 complete a handshake at the Cloudflare edge, and a client capped
# at 1.1 is refused there (curl exits 35 with no HTTP status). These probes never
# reach the origin: the Origin CA certificate is checked by Cloudflare, not by them.
openssl s_client -connect herkules.dev:443 -servername herkules.dev -tls1_2 </dev/null 2>/dev/null | grep -m1 'Cipher is'
openssl s_client -connect herkules.dev:443 -servername herkules.dev -tls1_3 </dev/null 2>/dev/null | grep -m1 'Cipher is'
curl --tls-max 1.1 -s -o /dev/null https://herkules.dev/ && echo "TLS 1.1 ACCEPTED: the floor is not 1.2" || echo "TLS 1.1 refused"

# The two records that depend on the settings: redirect and an ordinary app.
curl -sI https://www.herkules.dev/ | grep -iE '^(HTTP|location)'
curl -s -o /dev/null -w 'bbs: %{http_code}\n' https://bbs.herkules.dev/
```

Expected: `200`, a `301` to `https://herkules.dev/`,
`strict-transport-security: max-age=15552000; includeSubDomains`, a `Cipher is` line
for each of TLS 1.2 and 1.3, "TLS 1.1 refused", a `301` from `www` to the apex, and
`200` from `bbs`. A TLS 1.2 or 1.3 handshake failure is an edge problem, since the
probes stop at Cloudflare. An Origin CA certificate that no longer satisfies
`ssl = "strict"` shows up instead as a `526` on the HTTP requests above.

And the redirect contract, which is what `zone-rules.tf` can break. The last two lines
are the subtle ones: the rule matches the **full URI** and only `https://www.*`, so a
plain-HTTP `www` request is answered by `always_use_https` and stays on `www` for that
hop, and an apex deep link is not redirected at all.

```sh
# A deep link keeps its path and its query string across the hop.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://www.herkules.dev/bbs/search?q=x&page=2"

# Plain HTTP is the HTTPS-upgrade hop, so it lands on https://www..., not on the apex.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://www.herkules.dev/foo?a=1"

# The apex is served, not redirected.
curl -s -o /dev/null -w '%{http_code}\n' https://herkules.dev/bbs/
```

Expected on 2026-09-14: `301 https://herkules.dev/bbs/search?q=x&page=2`,
`301 https://www.herkules.dev/foo?a=1`, and `200`. A `301` on the third line means the
rule was widened off the `www` hostname; a `301` straight to the apex on the second
means it was widened off `https`, which would move the redirect in front of the
HTTPS-upgrade hop and change which request does the work.

## State

State lives in the private `herkules-tfstate` R2 bucket (`backend.tf`), migrated
there on 2026-09-14 with `terraform init -migrate-state` once the adoption plan was
clean. Local state is not acceptable when both a human and CI can apply.

The S3 backend reads the standard `AWS_*` names. They must hold an R2 API token
scoped to that bucket alone (Object Read & Write) — **not** the backup credentials
in `.env.backup` — exported from out-of-checkout files the same way as the API
token:

```sh
export AWS_ACCESS_KEY_ID="$(cat ~/.config/herkules/terraform/r2-access-key-id)"
export AWS_SECRET_ACCESS_KEY="$(cat ~/.config/herkules/terraform/r2-secret-access-key)"
```

Locking needs no DynamoDB: `use_lockfile` relies on the conditional `PutObject` that
R2 implements. R2 has no bucket versioning, so there is no undo for a corrupted
state object. That is acceptable only while the managed scope holds no secrets,
which is why the Access identity provider and service token stay out of Terraform.

The state contains no secrets at this scope (no certs, no R2 keys, no tokens), but
it does contain every managed record and must not be committed. The root
`.gitignore` covers `*.tfstate`, `*.tfstate.*`, `**/.terraform/*`, and `*.tfvars`.
A `terraform.tfstate` left in this directory is the empty placeholder a remote
backend leaves behind, and `terraform.tfstate.backup` the pre-migration copy; both
can be deleted. The `.terraform.lock.hcl` dependency lock file is deliberately
**not** ignored and is committed, since it pins the provider version and its
checksums, so `init` on a covered platform leaves it unchanged.
