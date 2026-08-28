#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pyjwt[crypto]>=2.8"]
# ///
"""Reference verifier for herkules access tokens (docs/tokens.md, contract_version 1).

The whole contract in one function: `verify(token, issuer, resource, keys)`
returns the HTTP status, the exact `WWW-Authenticate` value (or None) and the
verified claims. A real server swaps `keys` for `jwt.PyJWKClient(f"{issuer}/jwks")`
(cache ≤5 min, one refetch per unknown kid) and answers 503 when that fetch fails.

    uv run docs/verify_token.py            # runs docs/tokens-vectors.json
"""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import jwt

ALG, TYPES, ROLES, LEEWAY = "EdDSA", ("at+jwt", "application/at+jwt"), ("admin", "member"), 60


def resource_metadata_url(resource):
    u = urlsplit(resource)
    return f"{u.scheme}://{u.netloc}/.well-known/oauth-protected-resource{u.path.rstrip('/')}"


def verify(token, issuer, resource, keys):
    prm = resource_metadata_url(resource)
    challenge = lambda d: (401, f'Bearer error="invalid_token", resource_metadata="{prm}", error_description="{d}"', None)
    if not token:
        return 401, f'Bearer resource_metadata="{prm}"', None
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != ALG or header.get("typ") not in TYPES or not header.get("kid"):
            return challenge("invalid token")
        key = keys[header["kid"]]  # KeyError -> unknown kid (refetch once, then reject)
        claims = jwt.decode(token, key, algorithms=[ALG], issuer=issuer, audience=resource, leeway=LEEWAY,
                            options={"require": ["sub", "aud", "exp", "iat", "jti"]})
    except jwt.ExpiredSignatureError:
        return challenge("token expired")
    except (jwt.PyJWTError, KeyError, ValueError):
        return challenge("invalid token")
    if "cnf" in claims or claims.get("role") not in ROLES or not (claims.get("client_id") or claims.get("azp")):
        return challenge("invalid token")
    return 200, None, claims


def main():
    vectors = json.loads((Path(__file__).parent / "tokens-vectors.json").read_text())
    keys = {k.key_id: k.key for k in jwt.PyJWKSet.from_dict(vectors["jwks"]).keys}
    failed = 0
    for v in vectors["vectors"]:
        status, www, claims = verify(v["token"], vectors["issuer"], vectors["resource"], keys)
        want = v["expect"]
        got_principal = {k: claims.get(k) for k in ("sub", "role", "client_id", "jti")} if claims else None
        ok = status == want["status"] and www == want["www_authenticate"] and got_principal == want.get("principal")
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {v['name']}" + ("" if ok else f": got {status} {www!r} {got_principal}"))
    print(f"{len(vectors['vectors']) - failed}/{len(vectors['vectors'])} vectors pass")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
