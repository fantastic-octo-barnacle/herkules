# herkules access tokens — resource server contract

> `contract_version: 1`. Normative. `packages/auth-middleware/tests/contract.test.ts`
> pins every literal string quoted in §12, and `docs/tokens-vectors.json` is run
> against both `@herkules/auth-middleware` and `docs/verify_token.py`.

Audience: anyone writing a resource server in any language. Reading only this
file, you can accept a herkules access token and challenge correctly. The key
words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are RFC 2119.

## 1. Purpose and conformance

A **resource server** is any herkules process that accepts a herkules access
token: every MCP server under `/mcp/<name>` and every HTTP API under
`/api/<service>`. It never issues tokens and never talks to GitHub; it verifies
a token the authorization server minted and decides, from the claims inside,
what the caller may do.

A server is **conformant** when it satisfies every MUST in §15 and passes the
three checks FRAME.md's done predicate names: it rejects a token minted for
another resource (§7), it answers the §12 responses byte for byte, and a
~30-line verifier written from this document alone (`docs/verify_token.py` is
the reference) passes `docs/tokens-vectors.json`.

`@herkules/auth-middleware` is a TypeScript convenience over this document. It
is never a superset: anything it accepts, this document permits; anything it
emits, this document prescribes.

## 2. Terms

| Term                   | Meaning                                                                                  | herkules value                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Issuer                 | The authorization server; the `iss` claim                                                | `https://herkules.dev/auth`                                             |
| Resource               | A server that accepts tokens                                                             | —                                                                       |
| Canonical resource URL | The exact string that identifies a resource; also its `aud` value                        | `https://herkules.dev/mcp/<name>`, `https://herkules.dev/api/<service>` |
| Audience               | The resource(s) a token was minted for; the `aud` claim                                  | one canonical resource URL                                              |
| Principal              | What a server knows about the caller after verification (§10)                            | —                                                                       |
| Client                 | The registered program that obtained the token (an IDE, a script); the `client_id` claim | —                                                                       |
| Challenge              | The `WWW-Authenticate` header that tells a client how to obtain a usable token           | §12                                                                     |

## 3. Endpoints and discovery

| Document                               | URL                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWKS (public keys)                     | `{issuer}/jwks`                                                                                                                                   |
| AS metadata (RFC 8414)                 | `{issuer}/.well-known/oauth-authorization-server`, and the path-inserted alias `https://herkules.dev/.well-known/oauth-authorization-server/auth` |
| Protected resource metadata (RFC 9728) | `https://herkules.dev/.well-known/oauth-protected-resource/mcp/<name>` (§13)                                                                      |

Protected resource metadata is served by the auth service from its registry.
Resource servers point at it in challenges and MUST NOT serve their own copy in v1.

Local development uses the issuer `http://localhost:<port>/auth`. A verifier
MUST accept the issuer it is configured with verbatim and MUST NOT special-case
development: the only difference between environments is configuration.

## 4. Token format

A compact JWS (RFC 7515) carrying a JWT claims set, per RFC 9068.

- Protected header: `typ` is `at+jwt` (`application/at+jwt` is equivalent,
  compared case-insensitively); `alg` is `EdDSA` (Ed25519); `kid` is always present.
- Verifiers MUST reject any other `typ` or `alg` **before touching keys** and
  MUST NOT accept `none`. A missing `kid` is rejected the same way.
- Lifetime is 15 minutes. There is no `nbf`.
- Tokens are opaque to clients. Only resource servers parse them.

## 5. Claims

| Claim       | Type                    | Required      | Set by | Verifier                                                                                           |
| ----------- | ----------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `iss`       | string                  | yes           | AS     | MUST equal the configured issuer (§6)                                                              |
| `sub`       | string                  | yes           | AS     | The user id. The only storage key (§10)                                                            |
| `aud`       | string, MAY be array    | yes           | AS     | MUST contain this resource's canonical URL (§7)                                                    |
| `client_id` | string                  | yes           | AS     | Which client obtained the token. Audit only                                                        |
| `azp`       | string                  | no            | AS     | Equal to `client_id`. MAY be used as a fallback when `client_id` is absent                         |
| `scope`     | string, space-separated | no            | AS     | In v1 exactly `offline_access` (the scope that yields a refresh token). MUST NOT be required (§11) |
| `role`      | `"admin"` \| `"member"` | **yes in v1** | AS     | Reject any other value or absence (§11)                                                            |
| `iat`       | number (seconds)        | yes           | AS     | MUST NOT be in the future beyond tolerance (§8)                                                    |
| `exp`       | number (seconds)        | yes           | AS     | MUST be in the future within tolerance (§8)                                                        |
| `jti`       | string                  | yes           | AS     | Correlation id. MAY be logged; never a key                                                         |
| `sid`       | string                  | no            | AS     | Present when the token is tied to a browser session                                                |
| `cnf`       | object                  | no            | AS     | Reserved for DPoP. A v1 verifier MUST reject a token carrying it (§14)                             |

AS-owned claims always win. The AS may enrich tokens with custom claims, but
`role` cannot be forged by a client and no custom claim overrides `sub`, `aud`,
`iss`, `exp` or any other row above. A verifier MAY expose unrecognized claims
read-only; it MUST NOT act on a claim this table does not name.

## 6. Verification procedure

A verifier MUST perform these steps in this order. Each names the §12 response
it maps to.

1. **Extract** the token from the `Authorization` header (§12.1 if absent or
   empty). The scheme is `Bearer`, compared case-insensitively; any other
   scheme, including `DPoP`, or a token containing whitespace, is §12.2 with
   description `invalid authorization header`. Tokens are accepted from the
   header only (`bearer_methods_supported: ["header"]`): never from a query
   parameter or form body.
2. **Check the header**: `alg` is `EdDSA`, `typ` is `at+jwt`, `kid` is
   present. Failure is §12.2 (`invalid token`). This step costs no key lookup.
3. **Resolve the key** by `kid` from the JWKS (§9). Unknown after one refetch
   is §12.2. Fetch failure with no usable set is §12.5.
4. **Verify the signature.** Failure is §12.2.
5. **Check `iss`** equals the configured issuer by exact string comparison. No
   normalization: a trailing slash is a different issuer. Failure is §12.2.
6. **Check `aud`** per §7. Failure is §12.2.
7. **Check `exp` and `iat`** with tolerance per §8. Expired is §12.2 with
   description `token expired`; an `iat` in the future is §12.2 `invalid token`.
8. **Check required claims** per §5: `sub`, `aud`, `exp`, `iat`, `jti`,
   `client_id` (or `azp`) present and of the stated type; `role` present and
   one of the two values. Failure is §12.2.
9. **Refuse `cnf`** (§14). Presence is §12.2.
10. **Build the principal** (§10). Only now may the request proceed to
    authorization (§11) and the handler.

A verifier MUST NOT short-circuit on a claim before the signature is verified,
except for the header checks in step 2 (which read only the protected header).

## 7. Audience rules

Every resource server has exactly one audience: its canonical resource URL,
compared byte for byte. The canonical form has a scheme, host and path; no
trailing slash, query, fragment or credentials. `https://herkules.dev/mcp/directory`
and `https://herkules.dev/mcp/directory/` are different audiences.

- `aud` string: MUST equal the canonical URL.
- `aud` array: MUST contain the canonical URL as one element.
- Prefix, origin or pattern matching is escalation: a token for
  `/mcp/directory` must not open `/mcp/directory-admin`, and a token for the
  origin must not open any path.

A token for another herkules resource is invalid here although the same issuer
signed it. This audience-binding property is what the self-test MCP server
exercises, and what `tokens-vectors.json` `wrong_audience` pins.

## 8. Clock skew

Verifiers SHOULD tolerate up to 60 seconds of skew on `exp` and `iat` and MUST
NOT tolerate more than 300 seconds. Hosts SHOULD run NTP. `exp` is the only
revocation a resource server sees: a disabled user keeps working on a resource
server for at most the token lifetime (15 minutes) plus tolerance. Servers that
need a tighter bound call the user-info API (§10) on sensitive operations.

## 9. Keys: JWKS, `kid`, rotation, caching

The JWKS at `{issuer}/jwks` is a JSON object `{"keys": [...]}` whose members
are Ed25519 public keys:

```json
{
  "kty": "OKP",
  "crv": "Ed25519",
  "x": "<base64url>",
  "kid": "<uuid>",
  "alg": "EdDSA",
  "use": "sig"
}
```

Rules:

- **Select by `kid`.** During rotation the issuer publishes old and new keys
  for a grace period (30 days), so a verifier MUST select by `kid` and MUST NOT
  pin a single key.
- **Cache** the set, SHOULD be for at most 5 minutes.
- **Unknown `kid`**: refetch once, then reject §12.2 if still unknown. Do not
  refetch for unknown kids more often than once per 30 seconds; a garbage
  `kid` must not cost one request per token. Accepted consequence: a key
  rotated within 30 seconds of a reload is rejected for the rest of that window.
- **Transport**: fetch over TLS, MUST NOT follow redirects, SHOULD time out at
  5 seconds.
- **Outage**: if the fetch fails and no usable set exists, respond §12.5 (503),
  never 401. A 401 during an auth-service outage would send every connected
  client back through consent at once. If a previously fetched set exists,
  a verifier MAY keep using it until the fetch succeeds.
- MUST NOT embed the public key in configuration. Keys come from the JWKS.

## 10. Identity and storage keying

- `sub` is the opaque, stable user id and the ONLY value a server may key
  per-user storage on.
- `client_id` identifies the client program. Use it for audit; never as a key
  and never for authorization.
- Display name, avatar and GitHub identity come from the user-info API:
  `GET https://herkules.dev/auth/api/users/{sub}` with the caller's own token
  forwarded as `Authorization: Bearer`; any valid member token for any
  registry resource is accepted there. These values MUST NOT be stored as keys.
- `jti` MAY be logged for correlation with the auth service's audit log.
- A development issuer mints different `sub` values from production. Data
  keyed on `sub` does not carry between environments.

The **principal** a conformant server derives is: `subject` (`sub`), `role`,
`clientId`, `resource` (this server's canonical URL, confirmed in `aud`),
`scopes` (the split `scope`, empty in v1), `issuedAt`, `expiresAt`, `tokenId`
(`jti`), optional `sessionId` (`sid`), and the raw token (needed to call the
user-info API on the caller's behalf).

## 11. Roles and scopes

`role` is a closed set, `admin` and `member`, resolved by the AS at issuance
from the user's row. `admin` satisfies any requirement `member` satisfies.

- A server MAY gate an operation on `role`. A failed role check is §12.4, a
  plain 403 with no challenge: re-authorizing cannot grant a role.
- A server MUST reject a token whose `role` is absent or not one of the two
  values (§12.2). Fail closed.

`scope` exists in the contract but carries only `offline_access` in v1, which
is an issuer-side concern (it is the scope that yields a refresh token). A v1
server MUST NOT require any scope and SHOULD NOT advertise `scope=` in a 401
challenge. When scopes arrive in a later contract version: exact set
membership, no hierarchy, and a missing-scope failure is §12.3 naming every
missing scope at once.

## 12. Responses

The status, `WWW-Authenticate` value and body for each outcome. `<prm-url>` is
this resource's protected-resource-metadata URL (§13).

### 12.1 No credentials

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="<prm-url>"
```

No `error` parameter (RFC 6750 §3.1: the request lacked authentication
information). Body message `missing bearer token`.

### 12.2 Invalid or expired token

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<prm-url>", error_description="token expired"
```

`error_description` is `token expired` when and only when the signature
verified and `exp` is past; it is `invalid authorization header` for a
malformed `Authorization` header (§6 step 1); and it is `invalid token` for
every other failure. The description MUST NOT echo the token and MUST NOT name
the failing check beyond these three strings: a finer description is a probing
oracle. Log the precise reason server-side.

### 12.3 Valid token, missing scope

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="<all missing, space-separated>", resource_metadata="<prm-url>", error_description="insufficient scope"
```

Reserved: a v1 server never emits it (§11).

### 12.4 Permission denied (role, ownership, per-record ACL)

```
HTTP/1.1 403 Forbidden
```

**No `WWW-Authenticate`.** A challenge would send the user through consent for
a grant that cannot help. The body message is server-supplied prose.

### 12.5 JWKS unavailable

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
```

No challenge. Body message `authorization keys unavailable, retry`.

### 12.6 Bodies

MCP servers MUST answer with a JSON-RPC error:

```json
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "<message>" }, "id": null }
```

Plain HTTP APIs SHOULD answer:

```json
{ "error": "<code>", "error_description": "<message>" }
```

where `<code>` is `invalid_token` (12.1, 12.2), `insufficient_scope` (12.3),
`forbidden` (12.4) or `unavailable` (12.5). Every error response carries
`Content-Type: application/json` and `Cache-Control: no-store`.

### 12.7 Header grammar

`WWW-Authenticate: Bearer` followed by comma-space separated `name="value"`
parameters in this order: `error`, `scope`, `resource_metadata`,
`error_description`, each present only when the subsection above lists it.
Values are RFC 7235 quoted-strings: `"` and `\` are escaped with `\`; control
characters never appear. `<prm-url>` is derived per §13 and MUST match the
document the auth service serves byte for byte, or clients cannot discover
the issuer.

## 13. Protected resource metadata document

For a resource `{origin}{path}` the document lives at the RFC 9728 §3.1
path-inserted URL `{origin}/.well-known/oauth-protected-resource{path}` with
no trailing slash: `https://herkules.dev/mcp/directory` →
`https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory`.

The auth service serves it from its static resource registry. Resource servers
MUST NOT serve their own copy in v1: one document per resource, one owner,
so a challenge and its discovery document cannot disagree. Its shape:

```json
{
  "resource": "https://herkules.dev/mcp/directory",
  "authorization_servers": ["https://herkules.dev/auth"],
  "bearer_methods_supported": ["header"],
  "dpop_signing_alg_values_supported": ["ES256", "..."],
  "scopes_supported": ["offline_access"],
  "resource_name": "herkules directory (MCP)"
}
```

How a client walks from a 401 to a login: it reads `resource_metadata` from
the challenge, fetches that document, takes `authorization_servers[0]`,
fetches the issuer's `/.well-known/oauth-authorization-server`, registers
itself (or presents its client metadata document), runs the authorization
code + PKCE flow requesting `resource=<canonical URL>`, and retries with the
token it receives. Every link in that chain is a string comparison, which is
why the header must be exact.

## 14. DPoP (reserved)

`cnf.jkt` may appear in future tokens, binding them to a client key. A v1
verifier MUST reject a token carrying `cnf` with §12.2, MUST reject the `DPoP`
authorization scheme the same way, and MUST NOT treat a sender-constrained
token as a bearer token. When DPoP becomes required, the challenge will be
`WWW-Authenticate: DPoP algs="ES256", resource_metadata="<prm-url>"` alongside
the Bearer challenge, and verifiers will validate the `DPoP` proof header
(RFC 9449) against `cnf.jkt`. Not yet required; a contract change (§17).

## 15. Verifier requirements checklist

- [ ] MUST verify the signature against the JWKS, selecting the key by `kid`.
- [ ] MUST check `typ` (`at+jwt`) and `alg` (`EdDSA`) before any key lookup; MUST NOT accept `none`.
- [ ] MUST check `iss` (exact string), `aud` (§7), `exp` and `iat` (§8), and the required claims (§5).
- [ ] MUST reject a missing or unknown `role`.
- [ ] MUST reject any token carrying `cnf`, and the `DPoP` scheme.
- [ ] MUST emit the §12 responses exactly, including bodies and `Cache-Control: no-store`.
- [ ] MUST NOT challenge on permission denial (§12.4).
- [ ] MUST NOT require any scope in v1.
- [ ] MUST NOT accept tokens when the JWKS is unreachable and no set is cached; MUST answer 503 then.
- [ ] MUST NOT embed the public key in configuration; MUST NOT follow JWKS redirects.
- [ ] MUST key per-user storage on `sub` only.
- [ ] SHOULD cache the JWKS ≤ 5 min and refetch at most once per 30 s for unknown kids.
- [ ] SHOULD tolerate ≤ 60 s of skew; MUST NOT tolerate > 300 s.
- [ ] SHOULD log `sub`, `client_id` and `jti` on rejection. MUST NOT log the token.

## 16. Worked examples and conformance vectors

`docs/tokens-vectors.json` holds a test-only Ed25519 key pair, the JWKS the
issuer would publish for it, and 16 vectors, each a token (or none) with the
expected status and `WWW-Authenticate` value. Valid vectors carry a far-future
`exp` so no clock control is needed; the test-only private key MUST NOT be
used anywhere else. Regenerate with `vp run vectors` in
`packages/auth-middleware`; run the reference verifier with
`uv run docs/verify_token.py`.

The `valid` vector, decoded:

```json
// header
{ "alg": "EdDSA", "typ": "at+jwt", "kid": "018f3c7e-6b1d-7a2e-9c4f-0a1b2c3d4e5f" }
// claims
{
  "iss": "https://herkules.dev/auth",
  "sub": "usr_01j9k3m8x2q4r6t8v0w2y4z6a8",
  "aud": "https://herkules.dev/mcp/directory",
  "client_id": "cli_claude_code",
  "azp": "cli_claude_code",
  "scope": "offline_access",
  "role": "member",
  "iat": 1756000000,
  "exp": 4000000000,
  "jti": "jti_0001"
}
```

Its JWKS entry is the single key in the vectors file. The exchanges:

```
# no token
GET /mcp/directory
→ 401, WWW-Authenticate: Bearer resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory"

# token for /mcp/directory-admin (wrong audience)
GET /mcp/directory   Authorization: Bearer <token>
→ 401, WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory", error_description="invalid token"

# expired
→ 401, WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory", error_description="token expired"

# success
→ handler runs with principal { subject: "usr_01j9k3m8x2q4r6t8v0w2y4z6a8", role: "member", clientId: "cli_claude_code", ... }
```

## 17. Contract changes

Additive changes (a server that ignores them stays conformant): `scope`
becoming non-empty for some resources; new custom claims; `cnf` becoming
accepted alongside bearer; new fields in the metadata document.

Breaking changes: a token without `role`; a new `alg`; a new issuer; DPoP
becoming required; a new response string in §12. A breaking change bumps
`contract_version` at the top of this file and in `tokens-vectors.json`, and is
announced before the authorization server starts issuing under it.
