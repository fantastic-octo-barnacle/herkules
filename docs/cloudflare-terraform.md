# Terraform for Cloudflare

Research and proposed plan for bringing `herkules.dev`'s Cloudflare
configuration under Terraform. Status: **DNS records implemented** in
[`tools/deploy/cloudflare/terraform/`](../tools/deploy/cloudflare/terraform/README.md);
zone settings and Access are the next passes. §1–§2 and §6 are the research
this rested on; §3–§5 and §7 are the decisions.

Provider facts below were read from the official provider's own documentation at
tag `v5.25.0`, not from memory.

## 1. What Cloudflare is doing for us today

Everything Cloudflare-side is currently configured by hand in the dashboard,
except the Workers asset delivery which is automated by our own script.

| Area                                  | Where it lives now                                   | Managed by              |
| ------------------------------------- | ---------------------------------------------------- | ----------------------- |
| DNS records (7 hostnames, proxied A)  | Cloudflare dashboard                                 | hand                    |
| SSL/TLS mode = Full (strict), TLS 1.3 | Cloudflare dashboard                                 | hand                    |
| Origin CA cert + key                  | `/etc/herkules-tls/` on the VPS                      | hand, manual rotation   |
| Workers asset routes (5 patterns)     | `tools/deploy/cloudflare/release.mjs`                | our script, per release |
| Workers script + asset uploads        | `wrangler deploy` from CI                            | our script, per release |
| R2 bucket + S3 credentials            | dashboard; keys in `.env.backup` on the box          | hand                    |
| Cloudflare Access (OIDC IdP + apps)   | Zero Trust dashboard                                 | hand                    |
| `gpu-4090.herkules.dev` tunnel/app    | Zero Trust dashboard + `cloudflared` on the GPU host | hand                    |

Twelve records, per the 2026-09-14 zone export: seven proxied A records
(`herkules.dev`, `www`, `bbs`, `status`, `ops`, `ai`, `ai-portal`) all pointing at
the VPS `124.156.183.221` with **no IPv6** — the box has no AAAA — plus two
proxied CNAMEs (`gpu-4090`, `capability-map`) to the Cloudflare Tunnel on the GPU
host, and three TXT records (SPF, `_dmarc`, `*._domainkey`). The SOA and NS
records are Cloudflare's.

Two hard boundaries already recorded in our own docs:

- `tools/deploy/cloudflare/README.md` says a future Terraform **must not** own
  the five route resources or the Worker uploads. Those are per-release mutable
  and their content is extracted from immutable image digests at deploy time.
- `tools/deploy/README.md` says the Origin CA **private key never enters Git,
  CI secrets or release bundles**, and rotation happens on the box.

Both of those constraints survive this research. Neither is a limitation we
should try to lift.

## 2. Provider facts (verified against cloudflare/cloudflare v5.25.0)

- Current line is **v5**, latest release `5.25.0` (published 2026-09-11).
  The v4 → v5 migration guide exists; the big rename is that the old
  `cloudflare_record` is now `cloudflare_dns_record`, and most
  `cloudflare_zone_settings_override` style resources are gone.
- Auth is an **API token** via `CLOUDFLARE_API_TOKEN` (or `api_token`).
  API keys still work but Cloudflare marks them legacy. The token must be
  exported by the runner, never written into `.tf` files.
- Every resource doc lists its **accepted permissions** in the header, which
  makes least-privilege token design tractable.

### Resources that cover our surface

| Need                         | Resource                                                           | Accepted permissions         |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Proxied A/CNAME records      | `cloudflare_dns_record`                                            | DNS Read, DNS Write          |
| Full (strict), TLS settings  | `cloudflare_zone_setting` (`setting_id` + `value`)                 | Zone Settings Read/Write     |
| Access apps                  | `cloudflare_zero_trust_access_application`                         | Zero Trust                   |
| Access policies              | `cloudflare_zero_trust_access_policy`                              | Zero Trust                   |
| Access OIDC IdP              | `cloudflare_zero_trust_access_identity_provider` (`type = "oidc"`) | Zero Trust                   |
| Access service tokens        | `cloudflare_zero_trust_access_service_token`                       | Zero Trust                   |
| Zero Trust account settings  | `cloudflare_zero_trust_organization`                               | Zero Trust                   |
| R2 buckets                   | `cloudflare_r2_bucket` (+ `_cors`, `_lifecycle`, `_lock`)          | R2 Write                     |
| R2 custom domain             | `cloudflare_r2_custom_domain`                                      | R2 Write                     |
| WAF / cache / redirect rules | `cloudflare_ruleset` (+ `cloudflare_filter`)                       | Zone WAF / Cache Rules Write |
| Account API tokens           | `cloudflare_account_token`                                         | API Tokens Write             |
| Turnstile                    | `cloudflare_turnstile_widget`                                      | Turnstile Write              |
| Zone lists                   | `cloudflare_list`, `cloudflare_list_item`                          | Account Lists Write          |
| Origin CA issuance           | `cloudflare_origin_ca_certificate`                                 | Origin CA Write              |

`cloudflare_zone_setting` is the right resource for TLS policy. It is one
resource per setting, addressed by `setting_id` with the value under `value`:

```hcl
resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict" # the value behind Cloudflare's "Full (strict)" label
}
```

Other setting IDs we care about, with their documented value types:

| `setting_id`               | Value                                       |
| -------------------------- | ------------------------------------------- |
| `ssl`                      | `"off"`, `"flexible"`, `"full"`, `"strict"` |
| `min_tls_version`          | `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`          |
| `tls_1_3`                  | `"on"`, `"off"`, `"zrt"`                    |
| `always_use_https`         | `"on"` / `"off"`                            |
| `automatic_https_rewrites` | `"on"` / `"off"`                            |
| `security_header`          | Object (HSTS)                               |
| `opportunistic_encryption` | `"on"` / `"off"`                            |

Every one of these supports `terraform import` as `<zone_id>/<setting_id>`,
which is what makes adoption of our live zone safe. The one oddity: for
`ssl_recommender`, use the `enabled` attribute instead of `value`.

`cloudflare_workers_script` **can** now carry static assets, and
`cloudflare_workers_route` exists. We should still not use either one — see §3.

### Notable gaps and sharp edges

- **`cloudflare_origin_ca_certificate` does not give you the private key.**
  It takes a CSR and returns the certificate and `expires_on`. We generate the
  keypair ourselves, keep the key on the box, and Terraform would only ever hold
  the public certificate. Caddy still needs both files on disk, so Terraform
  would add a state copy of a non-secret without removing the manual install
  step. **Leave Origin CA out of Terraform.**
- **R2 S3 credentials are not a first-class Terraform object.** `cloudflare_r2_bucket`
  manages the bucket, but there is **no resource for R2 API tokens / S3 access
  keys**. The only documented path is to create a `cloudflare_account_token` and
  derive the pair yourself (Access Key ID = the token's `id`, Secret Access Key =
  SHA-256 of the token's `value`). Both the token value and the derived secret
  land in state. Our `.env.backup` deliberately never leaves the box, so we keep
  R2 credentials out of Terraform entirely.
- **The Access application resource owns its app-scoped policies inline**, and
  `cloudflare_access_policy` is no longer standalone for them. Cloudflare's
  migration guide carries an explicit warning that a half-migrated config will
  **detach then garbage-collect live policies**. Another reason Access is a
  separate, later piece of work rather than a first step.
- **`self_hosted_domains` is deprecated** on Access applications in favour of
  `destinations`. New config should use `destinations`.
- **Two resources cannot be imported at all**: `cloudflare_zero_trust_organization`
  and `cloudflare_zone_dns_settings` both explicitly state _"does not currently
  support `terraform import`"_. Neither is in our chosen scope, and that is part
  of why Access and DNS-settings are deferred.
- **Workers static assets _are_ technically manageable** — `cloudflare_workers_script`
  exposes `assets.directory` plus an `assets.config` block, so the old "Wrangler
  is mandatory" assumption is out of date. This does **not** change our decision:
  the constraint is ownership, not capability. Our assets are extracted from
  immutable image digests at release time by `release.mjs`, so a Terraform apply
  would need those build outputs present and would fight the release job. Note
  also that the provider does not bundle for you, and `assets.directory` appears
  only in generated schema — never in an example.
- Terraform state stores values in **plaintext**, including anything not marked
  sensitive. A `Sensitive` marker only redacts CLI output; it does not remove the
  value from state. That is the main reason to keep secrets and certs out of scope.

## 3. Scope decision

### Adopted now: DNS records only

**Implemented** in [`tools/deploy/cloudflare/terraform/`](../tools/deploy/cloudflare/terraform/README.md).
The zone export of 2026-09-14 revealed **twelve** records, not the seven
hostnames we knew about from the READMEs:

| Records           | Detail                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| 7 × proxied A     | `@`, `www`, `bbs`, `status`, `ops`, `ai`, `ai-portal` → `124.156.183.221`        |
| 2 × proxied CNAME | `gpu-4090`, `capability-map` → the Cloudflare Tunnel on the GPU host             |
| 3 × TXT           | SPF (`v=spf1 -all`), `_dmarc` (`p=reject`), `*._domainkey` (revoked, empty `p=`) |

Three things only became visible from the export and are worth recording:

- `www` was created by a Cloudflare **Redirect Rule template**, and its redirect
  is a zone ruleset, not a DNS record. Adopting the record does not touch the
  rule, but deleting the record would break it.
- `capability-map` was not previously documented anywhere in the repo.
- The mail TXT records are genuinely load-bearing — `-all` plus `p=reject` is
  what prevents domain spoofing — which is the strongest single argument for
  putting DNS under version control with `prevent_destroy`.

Zone-level TLS settings and Access remain **hand-set** for now; the config
deliberately asserts nothing about them.

### Adopt next

1. **Zone TLS/security settings** — `ssl = "strict"`, `min_tls_version`,
   `tls_1_3`, `always_use_https`, `automatic_https_rewrites`, HSTS. These encode
   the "Full (strict)" contract the VPS and the Origin CA cert depend on. Today
   nothing catches a dashboard toggle that silently breaks it. Deferred only to
   keep the first apply small.
2. **Cloudflare Access** — the OIDC identity provider, the apps, and the
   policies for `gpu-4090.herkules.dev` and the AI portal. The most valuable
   long-term item: Access policy is security-relevant, hand-edited, and
   currently undocumented in the repo as code. Note the v5 inline-policy
   migration trap documented in §2.

### Adopt later, if it earns its place

3. **R2 bucket** (bucket definition only, no credentials) and `r2_custom_domain`.
4. **Zone rules** (`cloudflare_ruleset`) — cache rules, redirect rules, and any
   WAF/rate-limit policy. The `www` → apex redirect is one of these and is not
   managed today.

### Explicitly out of scope

- **Worker uploads and the five routes.** `release.mjs` owns them, the content
  is built from image digests at release time, and the README already forbids
  it. If Terraform also declared the routes it would fight the release job:
  every deploy calls `detach` then `attach`, so a `terraform plan` after any
  release would show drift from a managed state.
- **Origin CA certificate and key.** See §2.
- **R2 S3 credentials.** See §2.
- **Anything the release job mutates.** Rule of thumb: if a deploy changes it,
  Terraform must not own it.

This split means Terraform owns the **stable, hand-set, security-relevant**
configuration, and `release.mjs` keeps ownership of **per-release, build-derived**
configuration. There is no overlap, which is what makes the arrangement safe.

## 4. Proposed layout

Follows the existing `tools/deploy/<component>/` convention rather than adding a
new top-level directory:

```
tools/deploy/cloudflare/terraform/
├── README.md                  # how to plan/apply, token scopes, import steps
├── versions.tf                # required_version >= 1.7, provider pinned ~> 5.25
├── providers.tf               # provider + zone lookup by name
├── variables.tf               # api_token, root_domain, origin ipv4
├── dns.tf                     # the twelve records, one for_each resource
├── outputs.tf                 # zone id, record ids
├── tests/records.tftest.hcl   # invariants under a mocked provider
├── imports.tf                 # generated by cf-terraforming for adoption (optional to keep)
├── zone-settings.tf           # next pass: cloudflare_zone_setting resources
└── access.tf                  # later pass: IdP, applications, policies
```

Credentials are `TF_VAR_*` environment variables only; the root `.gitignore`
ignores every `*.tfvars` and state file, and commits the dependency lock.

The mechanical parts are delegated rather than written here: `cf-terraforming`
emits the import blocks, `terraform test` carries the invariants, and
`dflook/terraform-github-actions` does plan-on-PR (as a PR comment) and
apply-on-merge (refusing if the fresh plan differs from the reviewed one).
`terraform.yml` is inert until the `TERRAFORM_ENABLED` repository variable is
set; the credential-free checks run in `ci.yml` on every PR regardless.

### State backend: R2 vs HCP Terraform free tier

This was evaluated properly rather than assumed, because the ground moved in 2026. **Recommendation: R2 with the S3 backend.**

The old "Terraform Cloud is free" assumption is no longer accurate. The legacy
HCP Terraform Free plan reached end-of-life on **31 March 2026**; organisations
that did nothing were auto-migrated to the "enhanced" pay-as-you-go free tier,
which is capped at **500 managed resources** with **1 concurrent run**. Paid
tiers start around **$0.10/resource/month** (Essentials) and run to
$0.99 (Premium), billed on peak hourly resource count. Separately, IBM-era
HashiCorp has been moving formerly-free features behind higher tiers —
`terraform import` restrictions were reported from January 2025.

|                    | R2 + S3 backend                                         | HCP Terraform free tier                             |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| Cost               | R2 storage, effectively free at our size                | Free to 500 resources, then per-resource billing    |
| Resource cap       | None                                                    | 500 managed resources, 1 concurrent run             |
| Locking            | `use_lockfile` (needs conditional writes — R2 has them) | Built in                                            |
| Vendor surface     | Cloudflare, which we already depend on                  | Adds a third party to the deploy path               |
| Adoption risk      | We own the bucket and token                             | Plan/feature changes are outside our control        |
| `terraform import` | Plain CLI, no tier gating                               | Reportedly gated on HCP-driven runs                 |
| State portability  | Ours, in an S3-compatible bucket                        | Exportable, but workspace deletion is unrecoverable |

For **our** scale the 500-resource cap is not the binding constraint — DNS plus
zone settings is roughly a dozen resources. The deciding factors are the other
two: this stack is deliberately self-hosted and cost-controlled, and every
dependency we add to the deploy path is one we have to keep alive. We already
run Cloudflare for DNS, Workers, Access and R2 backups, so putting state there
adds no new vendor and no new failure domain.

R2 is viable as an S3 backend, and the specific detail that makes it work is
that Terraform's modern S3 locking writes a lock object with a conditional
`PutObject`, and [R2 implements `PutObject` conditional
operations](https://developers.cloudflare.com/r2/api/s3/api/) (`If-Match`,
`If-None-Match`) ✅. So `use_lockfile = true` works without DynamoDB — which
matters, because R2 has no DynamoDB.

Sketch (to be validated with a real `init` and `plan` before we rely on it):

```hcl
terraform {
  backend "s3" {
    bucket = "herkules-tfstate"
    key    = "cloudflare/herkules.dev.tfstate"
    region = "auto" # R2's region; "us-east-1" and "" also alias to it

    endpoints = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }

    # Required for R2 — disables S3-specific client-side validation.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true

    use_lockfile = true
  }
}
```

The credentials for that bucket come from `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` in the runner environment. Two caveats worth knowing:

1. **We do not need bucket versioning on the state bucket**, because R2 does not
   implement `PutBucketVersioning` (it is on Cloudflare's unimplemented list).
   That removes a safety net, so keep the state bucket private and treat it as
   sensitive — but note that on the scope chosen (DNS + zone settings) the state
   contains **no secrets**.
2. If `use_lockfile` misbehaves against R2 in practice, the fallback is a
   separate state bucket plus a lock object, or single-writer discipline
   (`apply` only from the `production` environment, which the workflow enforces
   anyway).

**What we give up by not using HCP Terraform:** the UI, run history, and built-in
sentinel/OPA policy enforcement. None of those are things this team currently
uses, and the workflow already gives us plan-on-PR and apply-on-merge.

**What would change the answer:** if we later adopt Terraform across many zones
or accounts and want run history and policy enforcement without building it, HCP
Terraform becomes more attractive — and at that point we would be paying anyway,
so the current free-tier ceiling is not the thing that decides it.

Local-only state is not acceptable once both a human and CI can apply.

### Tokens

Today one `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit + Workers Routes Edit
is exposed to CI on every production deploy. Terraform should **not** reuse it.
Two separate tokens, each scoped to what it does:

- **Release token** (existing, unchanged): Workers Scripts Edit, Workers Routes
  Edit. Used by `release.mjs`.
- **Terraform token** (new): **DNS Write** for the zone and **Zone Settings
  Write**, plus Account/Zone Read. Widen only when Access or R2 is adopted. The
  adopted scope needs nothing else, and there is no reason to grant it Workers
  or billing access.

The bootstrap problem (a token that can create tokens) is solved by creating the
Terraform token by hand once and storing it in the GitHub `production`
environment. `cloudflare_account_token` can manage tokens afterwards but is
itself a privilege-escalation surface — optional, and only worth it if we want
token rotation in CI.

## 5. Adopting the live zone without an outage

The zone is live. The failure mode to avoid is Terraform deciding to **recreate**
a record or reset a setting, or pruning records it does not know about.

1. **Generate config from reality; do not hand-write it.** Cloudflare's own
   [`cf-terraforming`](https://github.com/cloudflare/cf-terraforming) tool
   (`cf-terraforming generate`) reads the live API and emits HCL for what
   actually exists. Hand-writing records from memory is how you get a plan that
   silently replaces a live record. Its `import --modern-import-block`
   subcommand produces our `imports.tf`. Note that Cloudflare's own Terraform docs
   pages still ship v4-era code in places (its import guide, R2 remote-backend
   page and Bulk Redirects example all still show v4), so trust the provider's
   v5 schema over the surrounding prose and examples.
2. **Import via `import` blocks, not the CLI.** Terraform 1.5+ `import` blocks
   live in version control and are reviewable in a pull request, and
   `terraform plan -generate-config-out=generated.tf` will draft the config.
   The import itself touches nothing — all the risk is in the _post-import
   plan_, where a mismatched attribute means an in-place update or a
   **replace**.
3. **The gate: `terraform plan` must report no changes** on a fully imported
   configuration before `apply` is allowed anywhere near it.
4. **`prevent_destroy` on every adopted DNS record.** Note it blocks destroy and
   replace, but _not_ in-place updates — it is a guardrail, not a proof.
5. **Import zone settings one `setting_id` at a time**,
   `<zone_id>/<setting_id>`. Settings we do not import are simply left untouched,
   which is the safe default.
6. **Do not adopt unknown records yet.** Records we do not intend to manage
   should be documented and left alone, not imported and then accidentally
   deleted.
7. **When we later rename or retire a resource, use `moved` blocks** (or
   `removed { lifecycle { destroy = false } }` to stop managing something without
   deleting it). Without `moved`, a rename plans as create-duplicate plus
   destroy-original.
8. **Verify the real contract after the first apply**: `curl -fsS
https://herkules.dev/auth/healthz`, the OAuth discovery document, and the
   MCP 401 challenge, exactly as `tools/deploy/README.md` already prescribes.

Terraform only deletes a record it manages and that is absent from config, so the
practical risk is contained once imports are complete and verified.

## 6. Risks

| Risk                                             | Mitigation                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Terraform and `release.mjs` fighting over routes | Routes are out of scope by decision, not by convention                       |
| State leaks secrets                              | No certs, keys, or R2 credentials in scope                                   |
| A bad apply takes the site down                  | Import-then-plan-empty gate, `prevent_destroy`, apply only from `production` |
| Token over-privilege                             | Separate token, least privilege per resource's documented scopes             |
| State file is a single point of truth/failure    | R2 backend, private bucket; it is not on the critical serving path           |
| Provider v5 churn                                | Pin `~> 5.25`; v5 is the current line, v4 is behind us                       |

R2 cannot enable bucket versioning (unimplemented `PutBucketVersioning`), so the
state bucket has no built-in undo. That is acceptable only while state holds no
secrets, which is true for DNS + zone settings. **If scope later grows to include
Access or anything secret, revisit encryption or a versioned backend first.**

## 7. Decisions and remaining questions

Decided:

- **Scope:** **DNS records only** for the first configuration. Zone TLS settings
  and Access are next but deliberately not in this pass.
- **State:** R2 via the S3 backend (see §4). Local state is used for the adoption
  pass, then migrated before CI is allowed to apply.
- **Token:** a dedicated Terraform token, exposed as `TF_VAR_api_token` so it
  cannot be confused with the Workers release job's `CLOUDFLARE_API_TOKEN`. The
  zone ID is resolved from the domain name at plan time, so it is the only value
  a shell or CI has to carry.
- **Tooling:** nothing bespoke. `cf-terraforming` for import blocks,
  `terraform test` for invariants, `dflook/terraform-github-actions` for CI,
  Dependabot for provider bumps.
- **gpu-4090 is in scope**, as a DNS record only. Its tunnel's remote
  configuration is not managed.
- **Out of scope permanently:** Worker uploads, the five routes, Origin CA
  certificate and key, R2 S3 credentials.

Resolved by the 2026-09-14 zone export: the origin is `124.156.183.221`, and the
record set is the twelve records listed in §3 — including `www` and
`capability-map`, neither of which the runbooks previously mentioned.

Still needed before the first apply:

1. **Confirm the zone is the only thing in the account** that Terraform could
   reach. The token is scoped to one zone and DNS-only, so this is a
   belt-and-braces check rather than a live risk.
2. **A zone export or API read taken at apply time**, to confirm nothing changed
   since 2026-09-14. The import script fails loudly if a declared record is
   missing or ambiguous, so this is enforced rather than assumed.
3. **Whether `private_routing` is set** on any live record. The config leaves it
   unset on purpose; if a plan proposes changing it, that is the signal that the
   config needs the real value rather than Terraform asserting a default.

Zone settings are now a _next_ item, so the "which settings are non-default"
question moves to that pass rather than this one.

## References

- [Cloudflare provider, Terraform Registry](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [Provider v5 migration guide](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-migration)
- [Cloudflare Terraform tutorial](https://developers.cloudflare.com/terraform/tutorial/)
- [`cloudflare_dns_record`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record)
- [`cloudflare_zone_setting`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone_setting)
- [`cloudflare_origin_ca_certificate`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/origin_ca_certificate)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — conditional `PutObject`, and the unimplemented operations list
- [Configuring R2 with Terraform](https://developers.cloudflare.com/r2/examples/terraform-aws/) — the required `skip_*` provider flags
- [HCP Terraform free tier limits in 2026](https://scalr.com/learning-center/hcp-terraform-free-tier-is-being-discontinued-what-you-need-to-know) — free-plan EOL, the 500-resource cap, and per-tier pricing
- [End-of-life notice for the HCP Terraform legacy Free plan](https://support.hashicorp.com/hc/en-us/articles/47520801288083-End-of-Life-Notice-for-HCP-Terraform-Legacy-Free-Plan-HCP-Consul-Dedicated)
