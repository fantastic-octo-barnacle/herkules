/**
 * Owns the wire format of every failure response: RFC 6750 / RFC 9728
 * `WWW-Authenticate` grammar, parameter quoting, the two body styles, and the
 * 503. The ONLY module that writes a `WWW-Authenticate` header. Pure:
 * (AuthFailure, ChallengeContext) -> Response. Mirrors docs/tokens.md §12,
 * whose literal strings tests/contract.test.ts pins.
 */
import type { AuthFailure } from "./failure.ts";

/** MCP transports parse JSON-RPC; plain APIs get RFC 6750-style JSON. Chosen by constructor, not by option. */
export type BodyStyle = "json-rpc" | "json";

export interface ChallengeContext {
  readonly resourceMetadataUrl: string;
  readonly bodyStyle: BodyStyle;
}

/** The body-level error code (RFC 6750 vocabulary plus `unavailable` for the 503). */
type BodyCode = "invalid_token" | "insufficient_scope" | "forbidden" | "unavailable";

interface Rendered {
  readonly status: 401 | 403 | 503;
  readonly code: BodyCode;
  readonly message: string;
  /** Present only when a challenge is due. Parameter order per §12.7: error, scope, resource_metadata, error_description. */
  readonly challenge?: {
    readonly error?: "invalid_token" | "insufficient_scope";
    readonly scope?: string;
    readonly description?: string;
  };
}

/**
 * Exhaustive over `failure.kind`:
 *   missing_token           401  Bearer resource_metadata="..."                                  (no error param, RFC 6750 §3.1)
 *   malformed_authorization 401  Bearer error="invalid_token", resource_metadata="...", error_description="invalid authorization header"
 *   invalid_token           401  Bearer error="invalid_token", resource_metadata="...", error_description="token expired" | "invalid token"
 *   insufficient_scope      403  Bearer error="insufficient_scope", scope="a b", resource_metadata="...", error_description="insufficient scope"
 *   forbidden               403  NO WWW-Authenticate
 *   jwks_unavailable        503  Retry-After: 5, NO WWW-Authenticate
 * `error_description` distinguishes only "expired" from a generic string; a finer
 * description is a probing oracle. The precise reason lives in `failure` for logs.
 * Bodies: json-rpc -> {"jsonrpc":"2.0","error":{"code":-32000,"message":...},"id":null}
 *         json     -> {"error":"invalid_token"|"insufficient_scope"|"forbidden"|"unavailable","error_description":...}
 * Every response: Content-Type: application/json; Cache-Control: no-store.
 */
export function renderFailure(failure: AuthFailure, ctx: ChallengeContext): Response {
  const r = classify(failure);
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  if (r.challenge) {
    headers.set("www-authenticate", challengeHeader(r.challenge, ctx.resourceMetadataUrl));
  }
  if (r.status === 503) {
    headers.set("retry-after", "5");
  }
  const body =
    ctx.bodyStyle === "json-rpc"
      ? { jsonrpc: "2.0", error: { code: -32000, message: r.message }, id: null }
      : { error: r.code, error_description: r.message };
  return new Response(JSON.stringify(body), { status: r.status, headers });
}

function classify(failure: AuthFailure): Rendered {
  switch (failure.kind) {
    case "missing_token":
      return { status: 401, code: "invalid_token", message: "missing bearer token", challenge: {} };
    case "malformed_authorization": {
      const message = "invalid authorization header";
      return {
        status: 401,
        code: "invalid_token",
        message,
        challenge: { error: "invalid_token", description: message },
      };
    }
    case "invalid_token": {
      const message = failure.reason === "expired" ? "token expired" : "invalid token";
      return {
        status: 401,
        code: "invalid_token",
        message,
        challenge: { error: "invalid_token", description: message },
      };
    }
    case "insufficient_scope": {
      const message = "insufficient scope";
      return {
        status: 403,
        code: "insufficient_scope",
        message,
        challenge: {
          error: "insufficient_scope",
          scope: failure.missing.join(" "),
          description: message,
        },
      };
    }
    case "forbidden":
      return { status: 403, code: "forbidden", message: failure.reason };
    case "jwks_unavailable":
      return { status: 503, code: "unavailable", message: "authorization keys unavailable, retry" };
  }
}

function challengeHeader(
  c: NonNullable<Rendered["challenge"]>,
  resourceMetadataUrl: string,
): string {
  const params: string[] = [];
  if (c.error) params.push(`error=${quoteAuthParam(c.error)}`);
  if (c.scope !== undefined) params.push(`scope=${quoteAuthParam(c.scope)}`);
  params.push(`resource_metadata=${quoteAuthParam(resourceMetadataUrl)}`);
  if (c.description) params.push(`error_description=${quoteAuthParam(c.description)}`);
  return `Bearer ${params.join(", ")}`;
}

/** RFC 7230 qdtext excludes CTLs other than HTAB. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/**
 * RFC 7235 quoted-string: escapes `\` and `"`, throws TypeError on control
 * characters (a caller-supplied description must never break the header).
 */
export function quoteAuthParam(value: string): string {
  if (hasControlChar(value)) {
    throw new TypeError("auth-param value contains a control character");
  }
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}
