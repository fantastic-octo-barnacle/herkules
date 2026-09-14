# Cloudflare configuration as code

Terraform for the `herkules.dev` zone and the Zero Trust account that fronts it.
**Managed today: the twelve DNS records, and the Cloudflare Access applications and
policies.** Zone TLS settings and zone rules are deliberately still out of scope
(see "Scope" below and [`docs/cloudflare-terraform.md`](../../../../docs/cloudflare-terraform.md)
for the full research and reasoning, including the agreed phase order in §8).

**Status: adopted, on remote state, live in CI.** Twelve records and two Access
applications with their two reusable policies are imported, state lives in the R2
backend (`backend.tf`), and `terraform plan` reports "No changes". `TERRAFORM_ENABLED`
is set, so a PR touching this directory gets a plan comment and a merge to `main`
applies it; the `production` environment holds `TF_VAR_api_token`,
`TF_STATE_ACCESS_KEY_ID` and `TF_STATE_SECRET_ACCESS_KEY`. The zone and the Access
configuration are **live**: read "Adopting the live zone" before re-running any part
of it.

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

Access objects, adopted 2026-09-14 and described in `access.tf`:

| Object              | Kind            | Where it applies                                            |
| ------------------- | --------------- | ----------------------------------------------------------- |
| `Herkules team`     | reusable policy | attached to `Capability Map` at precedence 1                |
| `AI Gateway only`   | reusable policy | attached to `Herkules GPU 4090` at precedence 1             |
| `Capability Map`    | self-hosted app | `capability-map.herkules.dev`, OIDC-only, 24h sessions      |
| `Herkules GPU 4090` | self-hosted app | `gpu-4090.herkules.dev`, service-token only (no login page) |

Deliberately not managed here, and why:

- **SOA / NS records.** Cloudflare owns them; managing them risks the zone's
  delegation for no benefit.
- **Zone SSL/TLS settings** (`ssl`, `min_tls_version`, HSTS, …). Deferred by
  decision. They stay hand-set in the dashboard for now.
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
- **R2 and zone rules.** Deferred, with the order agreed in
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
   - `Account` → `Access: Apps and Policies` → **Edit**
   - `Account` → `Access: Organizations, Identity Providers, and Groups` → **Read**
   - `Account` → `Access: Service Tokens` → **Read**

   Narrow the zone permissions to the `herkules.dev` zone. The Access permissions
   cannot be zone-scoped — Cloudflare's Access API is account-level, even though
   both managed applications sit on this zone — so they are scoped to this account
   only. It needs no Workers, R2, or billing permissions.

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

   | Endpoint                                            | Expected                                |
   | --------------------------------------------------- | --------------------------------------- |
   | `GET /zones/<zone>/dns_records`                     | `200`                                   |
   | `GET /accounts/<account>/access/apps`               | `200` — Phase B                         |
   | `GET /accounts/<account>/access/identity_providers` | `200` — Phase B                         |
   | `GET /accounts/<account>/access/service_tokens`     | `200` — Phase B                         |
   | `GET /accounts/<account>/access/organizations`      | `200` — Phase B                         |
   | `GET /zones/<zone>/settings`                        | `403` — Phase C adds Zone Settings      |
   | `GET /zones/<zone>/rulesets`                        | `403` — Phase D adds rules              |
   | `GET /zones/<zone>/workers/routes`                  | `403` — `release.mjs` owns these        |
   | `GET /accounts/<account>/workers/scripts`           | `403` — `release.mjs` owns these        |
   | `GET /accounts/<account>/r2/buckets`                | `403` — never granted                   |
   | `GET /zones/<other-zone>/dns_records`               | `403` — every other zone in the account |

   Two notes from the 2026-09-14 re-verification. `GET /zones` with no filter lists
   **all five** zones in the account, while `dns_records` and `settings` on the other
   four are `403`: the zone list is metadata, not reach, and is worth knowing before
   a config mistake is assumed to be contained by the token. `origin_ca_certificates`
   answers `400` rather than `403` (an unimplemented route), which is inconclusive
   either way; Origin CA stays never-granted by policy.

   Verified on 2026-09-14 against the production token, after the Phase B widening.

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

Since `backend.tf` now exists, `terraform init` initializes the R2 backend and
therefore needs the state credentials — and `cf-terraforming` inherits that
requirement. The original adoption could run without them because the backend
block did not exist yet.

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
- `http_only_cookie_attribute = false` must be stated. The provider defaults it to
  `true`, so omitting it silently changes the cookie Access hands the origin.
  `enable_binding_cookie`, `options_preflight_bypass`, and
  `auto_redirect_to_identity = false` on the service-token application are the same
  trap.
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

## Credential-free checks

The `terraform` job in `.github/workflows/ci.yml` runs on every PR, with no
token and no network access to Cloudflare:

- `terraform fmt -check`
- `terraform validate`
- `terraform test` — two files under a mocked provider. `tests/records.tftest.hcl`
  pins the record set, the mail TXT contents, that every A record is the proxied
  VPS, that there are no AAAA records, and the automatic TTL.
  `tests/access.tftest.hcl` pins the Access set, that every application reaches its
  destination through `destinations`, that each attached policy is a _reference_
  with an id rather than an inline copy, that `capability-map` stays OIDC-only, and
  that `gpu-4090` stays service-token-only.
- a grep that no `cloudflare_workers_*`, `cloudflare_origin_ca_certificate`, or
  `cloudflare_account_token` resource has crept in, and that neither
  `cloudflare_zero_trust_access_identity_provider` nor
  `cloudflare_zero_trust_access_service_token` is declared as a **resource** — the
  data source for the service token is expected, a resource would put a
  `client_secret` in state.

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
curl -sI https://ai-portal.herkules.dev/ | grep -iE '^(HTTP|location)'
```

Expected on 2026-09-14: `302` to `hxyulin.cloudflareaccess.com/cdn-cgi/access/login/capability-map.herkules.dev`,
`403`, and a `302` to `https://ai-portal.herkules.dev/dashboard` respectively. A
`302` on the second line, or an Access challenge on the third, means the adoption
changed which hostnames Zero Trust protects.

## State

State is **local** for the adoption pass on purpose: it keeps the first import a
solo, reviewable operation with no new infrastructure (no bucket, no token, no
workflow) created before the config is proven.

**Done on 2026-09-14:** the twelve records were imported, and state has since
migrated to the R2 backend below (`backend.tf`). The local `terraform.tfstate` is
now the empty placeholder a remote backend leaves behind, and
`terraform.tfstate.backup` is the pre-migration copy. `terraform plan` reports
"No changes" against the remote state, and the lock works — R2 implements the
conditional `PutObject` that `use_lockfile` needs.

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
