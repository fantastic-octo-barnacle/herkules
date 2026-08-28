/**
 * Owns URL knowledge: validating a resource identifier, deriving the JWKS URL
 * from the issuer, and deriving the RFC 9728 path-inserted protected-resource
 * metadata URL from the resource. Pure. Mirrors docs/tokens.md §3 and §13.
 */

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Validates and canonicalizes a resource identifier. Both rule sets reject
 * credentials, query and fragment (they break exact `aud` comparison) and a
 * trailing slash (normalized away). `"mcp"` additionally requires https, or
 * http on a loopback host, matching @better-auth/mcp's `validateMcpResource`.
 * @throws TypeError at construction time, so a typo is a boot failure, not a per-request 401.
 */
export function validateResource(resource: string, rules: "mcp" | "api"): string {
  const url = parse(resource, "resource");
  if (url.username || url.password)
    throw new TypeError(`resource must not carry credentials: ${resource}`);
  if (resource.includes("?") || resource.includes("#")) {
    throw new TypeError(`resource must not carry a query or fragment: ${resource}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`resource must be http(s): ${resource}`);
  }
  if (rules === "mcp" && url.protocol === "http:" && !LOOPBACK.test(url.hostname)) {
    throw new TypeError(`mcp resource must be https, or http on loopback: ${resource}`);
  }
  return url.origin + stripSlash(url.pathname);
}

/** `${issuer}/jwks` — where the Better Auth jwt plugin publishes. */
export function jwksUrlFor(issuer: string): string {
  parse(issuer, "issuer");
  return `${stripSlash(issuer)}/jwks`;
}

/**
 * RFC 9728 §3.1 path-inserted metadata URL:
 * `${origin}/.well-known/oauth-protected-resource${pathname}` (no trailing slash).
 * e.g. https://herkules.dev/mcp/directory -> https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory
 * This is the URL the auth service serves from its registry; resource servers point at it, never serve it.
 */
export function resourceMetadataUrlFor(resource: string): string {
  const url = parse(resource, "resource");
  return `${url.origin}/.well-known/oauth-protected-resource${stripSlash(url.pathname)}`;
}

function parse(value: string, what: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new TypeError(`${what} must be an absolute URL: ${value}`);
  }
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
