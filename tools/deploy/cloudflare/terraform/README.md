# Cloudflare DNS as code

Terraform for the `herkules.dev` zone. **This first pass manages DNS records
only** — zone TLS settings and Cloudflare Access are deliberately out of scope
(see "Scope" below and [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md)
for the full research and reasoning, including the agreed phase order in §8).

**Status: committed, not yet adopted.** The records have not been imported, there
is no remote backend, and `TERRAFORM_ENABLED` is unset, so
`.github/workflows/terraform.yml` is inert. The zone itself is **live**, so read
"Adopting the live zone" below before running anything, and do not run `apply`
until a plan comes back empty. Adoption is the next step, not something already
done.

## Scope

Managed here:

| Record                                           | Type  | Points at                                  |
| ------------------------------------------------ | ----- | ------------------------------------------ |
| `herkules.dev` (apex)                            | A     | VPS, proxied                               |
| `www`, `bbs`, `status`, `ops`, `ai`, `ai-portal` | A     | VPS, proxied                               |
| `gpu-4090`, `capability-map`                     | CNAME | Cloudflare Tunnel on the GPU host, proxied |
| `herkules.dev` (SPF)                             | TXT   | `v=spf1 -all`                              |
| `_dmarc`                                         | TXT   | `v=DMARC1; p=reject; sp=reject; ...`       |
| `*._domainkey`                                   | TXT   | `v=DKIM1; p=` (empty key, intentional)     |

Deliberately not managed here, and why:

- **SOA / NS records.** Cloudflare owns them; managing them risks the zone's
  delegation for no benefit.
- **Zone SSL/TLS settings** (`ssl`, `min_tls_version`, HSTS, …). Deferred by
  decision. They stay hand-set in the dashboard for now.
- **Cloudflare Access, R2, zone rules.** Deferred, with the order agreed in
  [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md) §8.
- **Worker uploads and the five Worker routes.** Permanently out of scope —
  `../release.mjs` owns them and derives their content from immutable image
  digests at release time. Two tools must never own the same resource. CI greps
  for `cloudflare_workers_*`, `cloudflare_origin_ca_certificate`, and
  `cloudflare_account_token` here and fails if one appears.

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

   Narrow it to the `herkules.dev` zone. It needs no Workers, R2, or billing
   permissions.

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

2. **Terraform >= 1.7** and **cf-terraforming**:

   ```sh
   brew install hashicorp/tap/terraform cloudflare/cloudflare/cf-terraforming
   ```

   OpenTofu also works with this HCL, and the CI actions have `tofu-*` twins.

## Adopting the live zone

The import blocks are generated from the live zone by Cloudflare's own tool
rather than hand-copied, so the IDs in Git are provably the ones Cloudflare
holds. `cf-terraforming` reads the provider schema from an initialised working
directory, so init first.

```sh
cd tools/deploy/cloudflare/terraform
terraform init

# 1. The zone ID: the right-hand column of the zone's Overview page in the
#    dashboard, or ask the config's own lookup:
ZONE_ID=$(terraform console <<< 'data.cloudflare_zone.this.id' | tr -d '"')

# 2. Generate the import blocks. Read-only against Cloudflare.
cf-terraforming import \
  --resource-type cloudflare_dns_record --zone "$ZONE_ID" \
  --token "$TF_VAR_api_token" --modern-import-block \
  --terraform-binary-path "$(which terraform)" --terraform-install-path . \
  > imports.tf
```

`cf-terraforming` names every address `cloudflare_dns_record.terraform_managed_resource_<id>`,
and the import block alone does not say which record an ID belongs to. To see
that mapping, generate the live HCL to a scratch file and read it side by side:

```sh
cf-terraforming generate \
  --resource-type cloudflare_dns_record --zone "$ZONE_ID" \
  --token "$TF_VAR_api_token" \
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

## Credential-free checks

The `terraform` job in `.github/workflows/ci.yml` runs on every PR, with no
token and no network access to Cloudflare:

- `terraform fmt -check`
- `terraform validate`
- `terraform test` — `tests/records.tftest.hcl` under a mocked provider. It
  pins the record set, the mail TXT contents, that every A record is the proxied
  VPS, that there are no AAAA records, and the automatic TTL.
- a grep that no `cloudflare_workers_*`, `cloudflare_origin_ca_certificate`, or
  `cloudflare_account_token` resource has crept in.

Run the same locally with `terraform fmt -check -recursive && terraform validate && terraform test`.

## Plans and applies in CI

`.github/workflows/terraform.yml` is inert until the repository variable
`TERRAFORM_ENABLED` is `true`. Once it is: a PR touching this directory gets its
plan posted as a comment by `dflook/terraform-plan`; the merge to main runs
`dflook/terraform-apply`, which re-plans and refuses if the result differs from
the plan that was commented and approved. The plan file never leaves the runner —
a saved plan contains variable values, the token included, in clear.

A weekly scheduled run generates the same plan without a comment and **fails the
workflow when the plan is non-empty**, so a hand-made dashboard change is noticed
instead of silently diverging from this directory.

## Before you touch the tunnel CNAMEs

`gpu-4090` and `capability-map` point at `aa133e92-...cfargotunnel.com`. These are
**plain DNS records** here. If the Cloudflare Tunnel is ever configured to manage
its own DNS records (for example by adopting `cloudflare_zero_trust_tunnel_cloudflared_config`),
the tunnel and this file will both try to own the same records and fight. Decide
which one owns them before doing that, and remove them from one side.

## The `www` record has a hidden dependency

`www` was created automatically by a Cloudflare **Redirect Rule** template (its
comment says so, and we preserve that comment). The redirect itself is a zone
ruleset, not a DNS record, and is **not** managed by this configuration. Adopting
the record does not break the redirect, but if you ever delete this record the
redirect loses its target. Zone rules are a deferred item; see the research doc.

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

## State

State is **local** for the adoption pass on purpose: it keeps the first import a
solo, reviewable operation with no new infrastructure (no bucket, no token, no
workflow) created before the config is proven.

**Done on 2026-09-14:** the twelve records are imported and `terraform plan`
reports "No changes". The state file is `terraform.tfstate` in this directory,
gitignored, and it now exists on one machine only — which is exactly why the
remote backend below is not optional.

Once the plan is clean and the records are imported, move to the R2 remote
backend described in [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md)
before letting CI apply:

```sh
terraform init -migrate-state
```

The backend needs a private `herkules-tfstate` bucket and an R2 API token scoped
to that bucket alone (Object Read & Write). Those are **not** the backup
credentials in `.env.backup`. The S3 backend reads the standard `AWS_*` names, so
export them from out-of-checkout files the same way as the API token:

```sh
export AWS_ACCESS_KEY_ID="$(cat ~/.config/herkules/terraform/r2-access-key-id)"
export AWS_SECRET_ACCESS_KEY="$(cat ~/.config/herkules/terraform/r2-secret-access-key)"
```

The commit that adds the backend block is the one that should flip
`TERRAFORM_ENABLED`. Local state is not acceptable once both a human and CI can
apply. The state file contains no secrets at this scope (no certs, no R2 keys, no
tokens), but it does contain every managed record and must not be committed. The
root `.gitignore` covers `*.tfstate`, `*.tfstate.*`, `**/.terraform/*`, and
`*.tfvars`; the `.terraform.lock.hcl` dependency lock file is deliberately **not**
ignored and is committed, since it pins the provider version and its checksums,
so `init` on a covered platform leaves it unchanged).
