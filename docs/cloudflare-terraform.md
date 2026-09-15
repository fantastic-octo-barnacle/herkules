# Terraform for Cloudflare

Research and plan for bringing `herkules.dev`'s Cloudflare configuration under
Terraform. Status: **DNS records, Cloudflare Access, and the zone's TLS/security
settings adopted 2026-09-14** — twelve records, two Access applications and their two
reusable policies, and ten zone settings, imported into the R2 backend from
[`tools/deploy/cloudflare/terraform/`](../tools/deploy/cloudflare/terraform/README.md),
with `terraform plan` reporting "No changes" against it and CI live behind
`TERRAFORM_ENABLED`. §1–§2 and §6 are the research; §3–§5 and §7 are the decisions;
§8 is the phase plan. Parts of §2 were corrected twice, because the pinned provider
line disagrees with the v4-era prose still quoted in that provider's own docs.

Provider facts below were read from the official provider's own documentation at
tag `v5.25.0`, not from memory.

## 1. What Cloudflare is doing for us today

Everything Cloudflare-side was originally configured by hand in the dashboard. Three
areas have since moved into Terraform — the DNS records, the Access applications and
policies, and the zone-level TLS/security settings (Phases A, B and C below). The
Workers asset delivery was already automated by our own script.

| Area                                  | Where it lives now                                   | Managed by              |
| ------------------------------------- | ---------------------------------------------------- | ----------------------- |
| DNS records (7 hostnames, proxied A)  | `tools/deploy/cloudflare/terraform/dns.tf`           | Terraform (Phase A)     |
| SSL/TLS mode = Full (strict), TLS 1.3 | `tools/deploy/cloudflare/terraform/zone-settings.tf` | Terraform (Phase C)     |
| Other zone settings (cache, speed, …) | Cloudflare dashboard                                 | hand, by decision (§8)  |
| Origin CA cert + key                  | `/etc/herkules-tls/` on the VPS                      | hand, manual rotation   |
| Workers asset routes (5 patterns)     | `tools/deploy/cloudflare/release.mjs`                | our script, per release |
| Workers script + asset uploads        | `wrangler deploy` from CI                            | our script, per release |
| R2 bucket + S3 credentials            | dashboard; keys in `.env.backup` on the box          | hand                    |
| Access applications + policies        | `tools/deploy/cloudflare/terraform/access.tf`        | Terraform (Phase B)     |
| Access OIDC IdP + service token       | Zero Trust dashboard                                 | hand, by decision (§3)  |
| Zero Trust organization settings      | Zero Trust dashboard                                 | hand, not importable    |
| `gpu-4090.herkules.dev` tunnel        | Zero Trust dashboard + `cloudflared` on the GPU host | hand                    |

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

| Need                                      | Resource                                                           | Accepted permissions                                         |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Proxied A/CNAME records                   | `cloudflare_dns_record`                                            | DNS Read, DNS Write                                          |
| Full (strict), TLS settings               | `cloudflare_zone_setting` (`setting_id` + `value`)                 | Zone Settings Read/Write                                     |
| Access apps                               | `cloudflare_zero_trust_access_application`                         | Access: Apps and Policies Read/Write                         |
| Access policies (reusable)                | `cloudflare_zero_trust_access_policy` (account-level)              | Access: Apps and Policies Read/Write                         |
| Access OIDC IdP                           | `cloudflare_zero_trust_access_identity_provider` (`type = "oidc"`) | Access: Organizations, IdPs, and Groups                      |
| Access service tokens                     | `cloudflare_zero_trust_access_service_token`                       | Access: Service Tokens Read/Write                            |
| Zero Trust account settings               | `cloudflare_zero_trust_organization`                               | Access: Organizations, IdPs, and Groups                      |
| R2 buckets                                | `cloudflare_r2_bucket` (+ `_cors`, `_lifecycle`, `_lock`)          | R2 Write                                                     |
| R2 custom domain                          | `cloudflare_r2_custom_domain`                                      | R2 Write                                                     |
| Zone rules (redirect, cache, config, WAF) | `cloudflare_ruleset`                                               | Single Redirect / Cache Rules / Config Rules / Zone WAF Edit |
| Account API tokens                        | `cloudflare_account_token`                                         | API Tokens Write                                             |
| Turnstile                                 | `cloudflare_turnstile_widget`                                      | Turnstile Write                                              |
| Zone lists                                | `cloudflare_list`, `cloudflare_list_item`                          | Account Lists Write                                          |
| Origin CA issuance                        | `cloudflare_origin_ca_certificate`                                 | Origin CA Write                                              |

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
- **Access policies: the standalone resource is the account-level _reusable_
  policy, and applications attach it by reference.** Verified against the pinned
  provider's own schema rather than its prose: `cloudflare_zero_trust_access_policy`
  requires `account_id`, `decision` and `name`, has **no `application_id` and no
  `precedence`**, exposes `reusable` and `app_count` as read-only, and imports as
  `<account_id>/<policy_id>`. An application carries its policies in its own
  `policies` list, whose entries are either a reference (`{ id, precedence }`) to an
  existing policy, or a full inline definition — the field description calls that
  "create new policies exclusive to the application". The `id` is optional, so an
  entry with neither `id` nor `include` is rejected by provider validation, while an
  entry with `include` **creates a second policy** instead of attaching the adopted
  one. An adoption pass must therefore give every entry the live id, and
  `tests/access.tftest.hcl` asserts it.

  **Corrected twice, 2026-09-14.** An earlier draft claimed the application resource
  owns its app-scoped policies inline and that `cloudflare_access_policy` is "no
  longer standalone". A later note reversed that and claimed the standalone form
  takes `application_id` plus `precedence` and imports as
  `account/<account_id>/<application_id>/<policy_id>`. Both were readings of v4-era
  prose. The schema and import lines above are what the pinned 5.25.0 provider
  actually implements, and the live account already uses that model: two reusable
  policies, each referenced by one application at `precedence = 1`.

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
  value from state. That is the main reason to keep secrets and certs out of
  scope. It also fixes the shape of the Access pass: the OIDC identity provider's
  `config.client_secret` and a service token's `client_secret` are both marked
  `Sensitive` and both land in state, while the same two values must already
  exist in `.env.auth` and on the GPU host. Managing those objects would duplicate
  a secret without removing a manual step, so §8 keeps them out and references
  them by ID.

## 3. Scope decision

### Adopted in Phase A: DNS records

(Phase B later added Access applications and policies to the same directory; §8 has
both passes. This section is the DNS record set and the decisions behind it.)

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
  rule, but deleting the record would break it. **Both are managed now** — the rule
  by §8 Phase D — so the pair can no longer drift apart silently.
- `capability-map` was not previously documented anywhere in the repo. It is
  another service on the same GPU host, published through the same tunnel and
  placed behind **Cloudflare Access with the Herkules OIDC login method**, so it
  is the second Access application for §8 Phase B — an identity policy, not the
  service token that `gpu-4090` uses.
- The mail TXT records are genuinely load-bearing — `-all` plus `p=reject` is
  what prevents domain spoofing — which is the strongest single argument for
  putting DNS under version control with `prevent_destroy`.

Zone-level TLS settings remain **hand-set** for now, and so do the three Access
objects this pass deliberately does not own — the identity provider, the service
token, and the organization. The config deliberately asserts nothing about any of
them. The Access **applications and policies**, the zone's **TLS/security
settings**, and the **`www` redirect rule** are the exception: §8 Phases B, C and D
adopted them, and the lists below record what that changed.

### Adopt next

1. **Zone TLS/security settings** — **done 2026-09-14**, see §8 Phase C. Ten settings
   are managed, headed by the ones that encode the "Full (strict)" contract the VPS
   and the Origin CA cert depend on. The survey found the contract weaker than the
   docs assumed in two places and this pass preserved both, deliberately: TLS 1.0 was
   still accepted, and no HSTS was sent. Both were hardened afterwards as their own
   reviewed change (2026-09-15, Phase C).
2. **Cloudflare Access** — **done 2026-09-14**, see §8 Phase B. The live account
   held exactly two applications, `capability-map.herkules.dev` and
   `gpu-4090.herkules.dev`, plus two reusable policies attached to them. The IdP
   and the service token stay hand-made, because managing them would copy their
   `client_secret` into state. Earlier drafts of this list included
   `ai-portal.herkules.dev`; the portal is **not** behind Access, and §8 records
   the evidence. See §2 for the policy-reference rule.

Nothing is left in this list: Phase D was the last phase on the agreed plan, and the
survey behind it found less to adopt than §8 expected (one ruleset, not three phases
of rules). What remains is the hardening and new-behaviour work listed in §8, which
is deliberately _not_ adoption.

### Adopt later, if it earns its place

3. **R2 bucket** (bucket definition only, no credentials) and `r2_custom_domain`.
4. **Zone rules** — **done 2026-09-14**, see §8 Phase D. The `www` → apex redirect is
   the only user-owned (`kind = "zone"`) ruleset on the zone: the other three in the
   list are Cloudflare-managed, and the cache, configuration and custom-WAF phases
   have no entry point ruleset at all. There is nothing else to adopt.

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
├── versions.tf                # required_version >= 1.10, provider pinned ~> 5.25
├── providers.tf               # provider + zone lookup by name
├── variables.tf               # api_token, root_domain, origin ipv4
├── dns.tf                     # the twelve records, one for_each resource
├── outputs.tf                 # zone id, record ids
├── backend.tf                 # R2/S3 remote state (added 2026-09-14)
├── tests/records.tftest.hcl   # invariants under a mocked provider
├── imports.tf                 # adoption-only: delete after import, it breaks terraform test
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

Sketch (to be validated with a real `init` and `plan` before we rely on it).
Cloudflare's own remote-backend page still labels its snippets v4-only and puts
the access keys inside the backend block; keep the keys in `AWS_*` environment
variables and treat the S3 backend's own option names as authoritative:

```hcl
terraform {
  backend "s3" {
    bucket = "herkules-tfstate"
    key    = "cloudflare/herkules.dev.tfstate"
    region = "auto" # R2's region; "us-east-1" and "" also alias to it

    endpoints = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }

    # Required for R2. All six appear on Cloudflare's own remote-backend page;
    # an earlier draft of this sketch was missing the middle three, and init can
    # fail against R2 without them.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

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
   MCP 401 challenge, exactly as `tools/deploy/README.md` already prescribes. Since
   Phase C, the Terraform README's TLS block joins them: apex, the plain-HTTP
   redirect, the absence of HSTS, and a TLS 1.2 and 1.3 handshake.

Terraform only deletes a record it manages and that is absent from config, so the
practical risk is contained once imports are complete and verified.

## 6. Risks

| Risk                                             | Mitigation                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform and `release.mjs` fighting over routes | Routes are out of scope by decision, not by convention                                                                                                                                                                                                                                        |
| State leaks secrets                              | No certs, keys, R2 credentials, or Access `client_secret` values in scope: the IdP is referenced by id, the service token through a data source that exposes no secret (§8)                                                                                                                   |
| A bad apply takes the site down                  | Import-then-plan-empty gate, `prevent_destroy`, apply only from `production`                                                                                                                                                                                                                  |
| An Access adoption locks people out of an app    | Same gate, plus the served contract (`capability-map` challenge, `gpu-4090` 403) is captured with `curl` before and after the apply, as the Terraform README prescribes                                                                                                                       |
| A settings adoption downgrades TLS or HSTS       | Same gate — the plan must read `0 to change`, so a live value can only be reproduced, never asserted — plus a handshake-and-HSTS probe captured before and after. `min_tls_version` and HSTS are hardening items, not adoption items (§8)                                                     |
| Token over-privilege                             | Separate token, least privilege per resource's documented scopes, re-probed after every widening                                                                                                                                                                                              |
| State file is a single point of truth/failure    | R2 backend, private bucket; it is not on the critical serving path                                                                                                                                                                                                                            |
| PR-branch code can read the production secrets   | Private repo, and fork PRs and Dependabot are excluded, so only collaborators who can push here can reach them. Required reviewers and protected branches both need a paid plan (HTTP 422 on Free, checked 2026-09-14), so this is accepted and recorded in `.github/workflows/terraform.yml` |
| Provider v5 churn                                | Pin `~> 5.25`; v5 is the current line, v4 is behind us                                                                                                                                                                                                                                        |

R2 cannot enable bucket versioning (unimplemented `PutBucketVersioning`), so the
state bucket has no built-in undo. That stays acceptable only because state holds no
secrets: DNS records, zone settings, plus Access objects whose secret-bearing parts
are referenced rather than managed (§8). State does now describe the live
configuration — policy rules, object ids, cookie settings, TLS values — so adding any
secret to state, or widening a later phase to include one, requires revisiting
encryption or a versioned backend first.

## 7. Decisions and remaining questions

Decided:

- **Scope:** DNS records (Phase A), Access applications and policies (Phase B), the
  zone's TLS/security settings (Phase C), and the `www` redirect ruleset (Phase D)
  are adopted. The cache, speed and challenge tuning inside the settings API stays
  hand-set by decision, as does the `ai.herkules.dev` cache/challenge exception,
  which the Phase D survey found had never been implemented at all (§8).
- **State:** R2 via the S3 backend (see §4). Local state is used for the adoption
  pass, then migrated before CI is allowed to apply.
- **Token:** a dedicated Terraform token, exposed as `TF_VAR_api_token` so it
  cannot be confused with the Workers release job's `CLOUDFLARE_API_TOKEN`. The
  zone ID is resolved from the domain name at plan time, so it is the only value
  a shell or CI has to carry. It gained account-scoped Access permissions in
  Phase B, Zone Settings in Phase C, and Zone rules in Phase D; the probe matrix is
  re-run after every widening, and a permission edit takes minutes to propagate at
  the edge (§8). Two of the Phase D scopes turned out to be unnecessary and are
  recorded as the first things to drop when the token is next rotated.
- **Access objects that carry secrets stay hand-made.** The OIDC identity provider
  is referenced by id and the service token through a data source that exposes no
  secret, so state never holds a `client_secret` (§2, §8). CI fails if either is
  declared as a resource.
- **Tooling:** nothing bespoke. `cf-terraforming` for import blocks,
  `terraform test` for invariants, `dflook/terraform-github-actions` for CI,
  Dependabot for provider bumps.
- **gpu-4090 is in scope** as a DNS record and its Access application. Its tunnel's
  remote configuration is not managed.
- **Out of scope permanently:** Worker uploads, the five routes, Origin CA
  certificate and key, R2 S3 credentials, the Access identity provider and service
  token, and the Zero Trust organization (not importable).

Resolved by the 2026-09-14 zone export: the origin is `124.156.183.221`, and the
record set is the twelve records listed in §3 — including `www` and
`capability-map`, neither of which the runbooks previously mentioned.

The three questions that were open before the first apply are settled:

1. **What the token can reach** is measured rather than assumed: the probe matrix in
   `tools/deploy/cloudflare/terraform/README.md` is re-run after every widening, and
   what it mostly proves is what the token _cannot_ reach. The original 2026-09-14
   probe found DNS and Access answering `200` while every other zone and API surface
   answered `403`.
2. **A read taken at apply time** happens on every plan, since each one reads the
   live objects; the import script additionally fails loudly if a declared record is
   missing or ambiguous.
3. **`private_routing`** has not appeared in a plan since the records were imported,
   which is what leaving it unset was meant to achieve. If a plan ever proposes
   changing it, that is the signal to read the live value rather than let Terraform
   assert a default.

Zone settings are now a _next_ item, so the "which settings are non-default"
question moves to that pass rather than this one.

## 8. Phase plan

Agreed 2026-09-14, after inventorying every Cloudflare dependency in the
repository (§1) and re-reading the provider's resource docs. Phases are lettered
so they cannot be confused with the §3 numbering.

### Phase A — finish the DNS adoption

**Done 2026-09-14.** All five steps are complete, including step 3: the `production`
secrets are set and `TERRAFORM_ENABLED` is `true`, so `terraform.yml` plans on pull
requests and applies on merge to `main`.

1. ~~Import the twelve records.~~ Done. The first plan read `12 to import, 0 to
add, 3 to change, 0 to destroy` — the three TXT records normalized from the
   API's quoted representation to the canonical unquoted value — the apply
   completed, and the follow-up plan reported "No changes". Served TXT values
   were byte-identical before and after.
2. ~~Create the bucket, the scoped R2 token, and the remote backend.~~ Done. State
   lives in `herkules-tfstate` under `cloudflare/herkules.dev.tfstate`, and
   `use_lockfile` works because R2 implements conditional `PutObject`. The empty
   plan is verified against the remote backend.
3. ~~Set the `production` secrets and flip `TERRAFORM_ENABLED`.~~ Done:
   `TF_VAR_api_token`, `TF_STATE_ACCESS_KEY_ID` and `TF_STATE_SECRET_ACCESS_KEY`
   are set, `TERRAFORM_ENABLED` is `true`, and the merge-time apply reported
   `Resources: 0 added, 0 changed, 0 destroyed` — the plan it re-ran matched the
   reviewed one.
4. ~~Add a scheduled plan.~~ Done: weekly, Mondays 06:00 UTC, failing on a
   non-empty plan. The `apply` gate was also narrowed to
   `push || workflow_dispatch`, because `event_name != 'pull_request'` is true for
   a scheduled run and would have applied.
5. ~~Extend the CI ownership grep.~~ Done: it now also rejects
   `cloudflare_origin_ca_certificate` and `cloudflare_account_token`, plus a guard
   that rejects a committed `imports.tf` — `terraform test` runs under a mock
   provider, which cannot import, so that file is adoption-only and breaks CI.
   Phase B added the Access identity-provider and service-token resources to the
   same check, and turned it from a line-based `grep` into one that strips block
   comments and flattens each file first — HCL accepts `resource /* c */ "type"` and
   a `/* ... */` comment may span the lines between them, both of which a line-based
   match reads past — and that rejects `*.tf.json`, which Terraform also evaluates
   and which the patterns cannot see.

Token: unchanged in Phase A — DNS Read, DNS Write, Zone Read.

### Phase B — Access applications and policies

**Done 2026-09-14.** `access.tf` manages two reusable policies and the two
applications that reference them; `terraform plan` reports "No changes"; CI covers
it exactly like the DNS pass. The survey changed the plan in five ways:

- **Two applications, not three.** The account holds exactly two: `Capability Map`
  on `capability-map.herkules.dev` and `Herkules GPU 4090` on
  `gpu-4090.herkules.dev`. There is **no** Access application for
  `ai-portal.herkules.dev` (nor for `ai.herkules.dev`). The portal is a VPS A record
  behind Caddy and New API's own login: an anonymous request is answered by its
  `/dashboard` redirect, not an Access challenge, whereas `capability-map` — a
  tunnel hostname like `gpu-4090` — does redirect to the team's Access login. The
  earlier claim that the portal sat behind Access was wrong, and putting it there
  would be a new control rather than an adoption.
- **The policies are account-level and reusable**, not app-scoped: `Herkules team`
  (`allow`, `include.login_method` = Herkules OIDC) and `AI Gateway only`
  (`non_identity`, `include.service_token`), each referenced by one application at
  `precedence = 1`. So §2's original instinct — a standalone policy resource — was
  right while its `application_id` mechanics were wrong.
- **This resource's defaults are a trap.** `http_only_cookie_attribute` defaults to
  `true` while both live applications have `false`; omitted, the first apply would
  have silently changed the Access cookie the origin receives.
  `enable_binding_cookie`, `options_preflight_bypass`, `auto_redirect_to_identity`,
  and an explicit `allowed_idps = []` are the same class of diff, and
  `connection_rules = { rdp = {} }` must be declared because Cloudflare reports it
  for account-level policies. All five were found by planning the candidate config
  against the live account before writing the file.
- **The IdP and the service token stay hand-made** (§2). The OIDC provider's
  `config.client_secret` is Sensitive in the schema but plaintext in state, so
  applications reference it by variable id; the service token is read through the
  `cloudflare_zero_trust_access_service_token` **data source**, verified to expose
  no `client_secret`, and found by name so the repository holds no opaque id. CI now
  fails if either is declared as a resource.
- **The invariants live in `tests/access.tftest.hcl`**: the application set, that
  each destination is declared through `destinations`, that every attached policy is
  a **reference carrying an id** (an inline entry would create a second policy), that
  `capability-map` stays OIDC-only, and that `gpu-4090` stays service-token-only.

The Zero Trust organization still cannot be imported (§2), so `is_ui_read_only`
remains a manual step. The honest limit of the whole phase: Terraform now _detects_
dashboard drift on these four objects, it does not prevent it.

Token: the probe matrix in the Terraform README was re-run after widening. Access
endpoints answer `200`; zone settings, rulesets, Workers routes, and R2 still answer
`403`. `GET /zones` lists all five zones in the account while the other four deny
DNS and settings reads — metadata, not reach.

Recorded by the survey and deliberately left alone, because each is a change to a
live authentication path rather than an adoption:

- The `Herkules team` policy allows **any** identity that authenticates through the
  Herkules OIDC provider. It is a login-method rule, not an email-domain or group
  restriction, so it is exactly as wide as the auth service's own registration
  policy — wider than the name suggests.
- The account still carries the built-in **One-time PIN** login method. It is an
  ordinary identity provider object and **nothing can reach it**: `capability-map`
  lists only the OIDC provider in `allowed_idps`, and `gpu-4090` has no interactive
  policy at all, answering `403` anonymously. So it is not a live fallback — an
  operator facing a broken OIDC provider would have to re-add OTP by hand first,
  which is the one reason to keep the object around rather than delete it. The
  provider also cannot manage it without a recurring diff
  ([issue #5693](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5693)),
  so removing it would be a deliberate one-off hand change.
- The organization's `session_duration`, `mfa_configuration`, and `is_ui_read_only`
  are all unset. Both applications also carry `http_only_cookie_attribute = false`
  and `enable_binding_cookie = false`, which the config now preserves deliberately:
  the session cookie Access issues is readable from JavaScript, and it cannot be
  tied to the browser that obtained it. Flipping either is a hardening candidate in
  its own right — `enable_binding_cookie = true` on `capability-map` in particular,
  since it is browser-only, and the Cloudflare docs recommend the binding cookie
  precisely against replay of a stolen `CF_Authorization` cookie — but both change
  behaviour for whatever reads that cookie, so neither belongs in an adoption.
  `ai-portal.herkules.dev` has no Zero Trust layer at all.
- The Terraform token carries `Access: Organizations, Identity Providers, and Groups`
  → **Read**, which the current configuration does not use: a traced plan calls only
  `access/apps`, `access/policies`, and `access/service_tokens`, because the IdP is
  referenced by id and the organization is not managed. It is kept for now because
  narrowing it means editing the production token by hand (the token has no
  `API Tokens` write scope, so this repository cannot do it), and the org/IdP
  hardening pass above will need it. Dropping that one permission is the
  least-privilege step to take first if the token is rotated for any other reason.

### Phase C — zone TLS and security settings

**Done 2026-09-14.** `zone-settings.tf` manages ten settings; `terraform plan` reports
"No changes"; CI covers it exactly like the other two passes. The survey changed the
plan in four ways:

- **Ten settings, not eleven.** `cf-terraforming` is the wrong tool for this resource
  — it emits one resource per setting with every read-only attribute — so the survey
  was a read of `GET /zones/<zone>/settings`: **56 settings, 44 editable**. The
  managed set is the contract, not the tuning: `ssl = "strict"`, `min_tls_version =
"1.0"`, `tls_1_3 = "on"`, `always_use_https = "on"`, `automatic_https_rewrites =
"on"`, `opportunistic_encryption = "on"`, `brotli = "on"`, `http3 = "on"`,
  `browser_check = "on"`, and `security_header`. The one candidate this drops is
  `http2`: the API reports `editable = false` for it on this plan, so a managed
  resource would have failed at apply. `mirage`, `polish`, `webp`, and the other
  image/performance settings are in the same category.
- **`value` is `Dynamic`**, so a single `for_each` cannot hold the set: Terraform
  needs one element type per map. The nine string settings share one `for_each` and
  the HSTS object is its own resource. Adopting `browser_cache_ttl` or
  `challenge_ttl` later means adding a number-valued group, and `ciphers` a
  list-valued one.
- **The contract was weaker than this document assumed, and the pass preserved it.**
  `min_tls_version` was `"1.0"`, and a TLS 1.0 handshake to the apex completed;
  `security_header` had `enabled = false`, so no HSTS was sent. Both were hardening
  changes rather than adoption — raising the floor locks out old clients, and HSTS is
  sticky in browsers for as long as its `max_age` says — so the adoption pass
  recorded them and a separate reviewed change applied them on **2026-09-15**:

  - **`min_tls_version`: `"1.0"` → `"1.2"`.** One value change. The zone accepted
    TLS 1.0 and 1.1 until then, below what any current guidance asks for; the
    README's probes now include a capped-at-1.1 client that must be refused.
  - **`security_header`: enabled, `max_age = 15552000` (six months),
    `include_subdomains = true`, `preload = false`, `nosniff = false`.** Six months
    rather than a one-day trial because there was nothing to trial: every hostname on
    the zone is proxied and `always_use_https` already redirects plain HTTP, so the
    header changes what browsers _attempt_, not what is served. `include_subdomains`
    commits `gpu-4090` and `capability-map`, both behind Access over HTTPS, and any
    future grey-cloud hostname that wanted plain HTTP. `preload` stays off: it needs
    a year's `max_age`, a submission to the browser lists, and months to undo, so it
    is its own decision. `nosniff` stays off because Caddy already sends
    `X-Content-Type-Options`.

- **`Delete` on this resource is a no-op** in provider 5.25.0 (read from
  `internal/services/zone_setting/resource.go`): destroying one removes it from state
  and leaves the live value alone. The `prevent_destroy` guards here therefore protect
  the drift _detection_, not the value, which is worth knowing before anyone reasons
  about them as they do the records' guards.

Two operational notes the pass produced. **A permission edit is not immediately
effective**: after `Zone Settings` was granted, the settings list answered `200`
while individual reads of `always_use_https`, `automatic_https_rewrites` and `brotli`
still answered `403` with code `10000` for several minutes, and one read flipped back
and forth in between — propagation, not a wrong permission, so re-probe before
changing anything (the README records it). And the **import gate is the whole
exercise**: `10 to import, 0 to add, 0 to change, 0 to destroy`, because every live
value has to match before anything is applied. The served TLS contract was captured
before and after and is identical: apex `200`, plain HTTP `301` to HTTPS, no HSTS
header, TLS 1.2 and 1.3 both handshaking, `www` still `301`, `bbs` `200`.

`terraform test` asserts the ten, `ssl = "strict"`, TLS 1.3 and the HTTPS-rewrite
family on, `http2` absent, `min_tls_version` at or above `1.2`, and HSTS enabled
with `include_subdomains`, a 30-day minimum `max_age` and `preload` off. The
adoption pass could only assert that `min_tls_version` was a value Cloudflare
accepts, because a floor would have failed against the `1.0` it was reviewed with;
the hardening change is what turned it into a real floor.

Token: Zone Settings Read/Write added, and the probe matrix re-run — settings answer
`200`, `rulesets` still `403` (Phase D).

### Phase D — zone rules

**Done 2026-09-14.** §8 expected three phases of rules here; the survey found one,
and the second half of the phase turned out never to have been implemented.

1. ~~Adopt the `www` → apex redirect~~ Done, in `zone-rules.tf`. The ruleset is
   `default` in `http_request_dynamic_redirect` and holds a single rule matching
   `http.request.full_uri wildcard r"https://www.*"`, redirecting `301` to a
   `wildcard_replace` of the same URI. `preserve_query_string` is `false` live and
   stays `false`: the path _and the query_ travel inside `full_uri`, so the obvious
   "fix" of enabling it would append the query a second time. The import read
   `1 to import, 0 to add, 0 to change, 0 to destroy` and the follow-up plan was empty.

   Matching on the full URI is also what keeps the rule from competing with
   `always_use_https`: a plain-HTTP `www` request is answered by that zone setting
   with a `301` to `https://www...`, and only the second hop reaches the rule.

2. **The `ai.herkules.dev` exception is not implemented, and this pass did not
   invent it.** [`tools/ai/README.md`](../tools/ai/README.md) asks for caching and
   interactive browser challenges to be bypassed on the API hostname. The survey
   found no ruleset in any phase that could do it:
   - `GET /zones/<zone>/rulesets` lists **four** rulesets. Three are
     `kind = "managed"` — Cloudflare's DDoS L7 entry point, its Managed Free
     Ruleset, and its URL normalization ruleset — and are not ours to declare. The
     fourth is the redirect above.
   - `GET /zones/<zone>/rulesets/phases/<phase>/entrypoint` answers `404` code
     `10003` ("could not find entrypoint ruleset") for
     `http_request_cache_settings`, `http_config_settings`, and
     `http_request_firewall_custom`.

   So the requirement is met today by default behaviour rather than by a rule: the
   API's responses are dynamic (`cf-cache-status: DYNAMIC`) and an ordinary request
   reaches the origin's own `401` with no challenge. That is an observation about
   today's traffic, not a guarantee — which is why writing the exception is a real
   decision rather than a tidy-up.

Token: `Zone` → `Single Redirect` → Edit was the one scope the phase needed.
`Cache Rules` and `Zone WAF` were granted for the survey and proved unnecessary;
`Config Rules` was never granted and is not needed, because the zone ruleset list is
readable without it. The probe matrix records all of it, and the two unused scopes
join the unused Access IdP/organization read as the first things to drop when the
token is next rotated.

#### Proposed next, not adopted

Each of these changes live behaviour, so each is its own reviewed change rather than
part of an adoption pass:

- **The `ai.herkules.dev` exception itself.** A cache rule bypassing cache on the API
  hostname, plus a configuration rule taking `security_level` to `essentially_off`
  (and possibly `bic` off) for it. It needs `Zone` → `Cache Rules` / `Config Rules` →
  Edit. The trade is explicit: a public hostname becomes exempt from the zone's
  challenge policy, in exchange for an API client never being handed a challenge
  page. The worker's Access policy on `gpu-4090` stays untouched — it lives in
  `access.tf`, so a plan would notice.
- ~~**The TLS floor and HSTS**~~ Done 2026-09-15; the values and the reasons are
  under Phase C above.
- **Access hardening:** narrow the deliberately wide `Herkules team` policy, remove
  the built-in OTP login method, set the organization's `session_duration`,
  `mfa_configuration` and `is_ui_read_only`, turn on `http_only_cookie_attribute`
  and `enable_binding_cookie`, and put `ai-portal.herkules.dev` behind Access.

### Phase E — zone hardening

**Done 2026-09-15**, as the follow-up to the TLS floor and HSTS. A read of the live
settings and DNS found the zone already better than assumed — DNSSEC active,
Encrypted Client Hello and post-quantum key exchange on, 0-RTT off — and three gaps:

- **CAA records: none existed**, so any public CA could issue for the domain. Eight
  were added in `dns.tf`: `issue` and `issuewild` for each of the four CAs Cloudflare
  lists for Universal SSL (`pki.goog` with `cansignhttpexchanges=yes`,
  `letsencrypt.org`, `ssl.com`, `sectigo.com`). Both tags because the Universal
  certificate covers the apex and the wildcard; all four because Cloudflare rotates
  among them and a missing one would block a renewal. No `iodef`: the zone has no MX.
  CAA is the first record type here that uses `data` rather than `content`, so the
  record resource now sets whichever of the two the entry carries.
- **DNSSEC was active but unmanaged.** `cloudflare_zone_dnssec` is declared with
  `status = "active"` and no import: the provider's Create is a PATCH of the status,
  which is a no-op against the live value, so the plan reads `1 to add` and applies
  without changing anything. Its Delete, by contrast, disables signing and removes
  the keys while the DS record is still at the registrar — an outage for the whole
  zone — so `prevent_destroy` is load-bearing. The DS value is exported as
  `dnssec_ds`.
- **Cipher suites cannot be restricted on this plan.** The API reports `ciphers` as
  editable, but zone-level customization needs an Advanced Certificate Manager
  subscription, so the intended "modern" list (the ECDHE AES-GCM and ChaCha20
  suites) was not adopted. Recorded as the one item this pass could not do.

Certificate Transparency monitoring is a dashboard toggle with no resource, and is
listed in the README as a hand-set guard.

### Later, if it earns its place

- `cloudflare_r2_bucket` for the backup bucket's definition, and
  `cloudflare_r2_bucket_lifecycle` to move the 30-day retention from the box's
  `rclone --min-age` to server-side expiry. Verify that resource's schema first.
- Zone cache rules: none needed. Caching is owned by Caddy and the asset Workers.

### Not Terraform

Unchanged from §3, with the tunnel made explicit: Worker uploads and the five
routes, the Origin CA certificate and key, R2 S3 credentials, and the tunnel's
remote configuration. The last would fight `dns.tf` for the two tunnel CNAMEs, so
the DNS records stay the one owner.

Phase B added three more, all for the same reason — they either carry a secret into
state or cannot be imported at all: the Access **identity provider** and **service
token** (§2), and the Zero Trust **organization**, which the provider cannot import,
so `is_ui_read_only` stays a hand-set switch.

### Adjacent, not Terraform

`Caddyfile` pins Cloudflare's published proxy ranges by hand, and the client-IP
trust chain depends on them. A CI check comparing the checked-in list against
`https://www.cloudflare.com/ips-v4` and `ips-v6` would catch a stale list; it
needs network access but no credentials.

## References

- [Cloudflare provider, Terraform Registry](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [Provider v5 migration guide](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-migration)
- [Cloudflare Terraform tutorial](https://developers.cloudflare.com/terraform/tutorial/)
- [`cloudflare_dns_record`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record)
- [`cloudflare_zone_setting`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zone_setting)
- [`cloudflare_origin_ca_certificate`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/origin_ca_certificate)
- [`cloudflare_zero_trust_access_application`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application) and [`cloudflare_zero_trust_access_policy`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_policy) — read the _schema_ and the import lines, not the prose summaries
- [Cloudflare One: identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/) and [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) — the login-method model behind §8's decision to leave the IdP hand-made
- [Provider issue #5693](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5693) — the recurring diff that makes the OTP login method a poor Terraform citizen
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — conditional `PutObject`, and the unimplemented operations list
- [Configuring R2 with Terraform](https://developers.cloudflare.com/r2/examples/terraform-aws/) — the required `skip_*` provider flags
- [HCP Terraform free tier limits in 2026](https://scalr.com/learning-center/hcp-terraform-free-tier-is-being-discontinued-what-you-need-to-know) — free-plan EOL, the 500-resource cap, and per-tier pricing
- [End-of-life notice for the HCP Terraform legacy Free plan](https://support.hashicorp.com/hc/en-us/articles/47520801288083-End-of-Life-Notice-for-HCP-Terraform-Legacy-Free-Plan-HCP-Consul-Dedicated)
