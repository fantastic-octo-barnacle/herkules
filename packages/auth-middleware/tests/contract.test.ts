/**
 * Pins docs/tokens.md §12: every status, WWW-Authenticate value and body the
 * contract quotes. If a string here changes, tokens.md changes with it.
 */
import { describe, expect, test } from "vite-plus/test";
import { renderFailure, quoteAuthParam } from "../src/challenge.ts";
import { apiResource, mcpResource } from "../src/index.ts";
import { createTestIssuer } from "../src/testing.ts";

const PRM = "https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory";
const RESOURCE = "https://herkules.dev/mcp/directory";
const ctx = { resourceMetadataUrl: PRM, bodyStyle: "json-rpc" } as const;

describe("§12 responses (renderFailure)", () => {
  test("12.1 no credentials: 401, challenge without error param", async () => {
    const r = renderFailure({ kind: "missing_token" }, ctx);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM}"`);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "missing bearer token" },
      id: null,
    });
  });

  test("12.2 expired token: description says only 'token expired'", () => {
    const r = renderFailure({ kind: "invalid_token", reason: "expired" }, ctx);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM}", error_description="token expired"`,
    );
  });

  test.each([
    "not_yet_valid",
    "bad_signature",
    "unknown_key",
    "wrong_issuer",
    "wrong_audience",
    "wrong_type",
    "wrong_algorithm",
    "dpop_bound",
    "malformed",
  ] as const)("12.2 invalid token (%s): generic description, no oracle", (reason) => {
    const r = renderFailure({ kind: "invalid_token", reason }, ctx);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM}", error_description="invalid token"`,
    );
  });

  test("12.2 malformed Authorization header", async () => {
    const r = renderFailure({ kind: "malformed_authorization" }, { ...ctx, bodyStyle: "json" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM}", error_description="invalid authorization header"`,
    );
    expect(await r.json()).toEqual({
      error: "invalid_token",
      error_description: "invalid authorization header",
    });
  });

  test("12.3 insufficient scope: 403 with every missing scope, parameter order error, scope, resource_metadata, error_description", async () => {
    const r = renderFailure(
      { kind: "insufficient_scope", missing: ["files:read", "files:write"] },
      ctx,
    );
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="files:read files:write", resource_metadata="${PRM}", error_description="insufficient scope"`,
    );
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "insufficient scope" },
      id: null,
    });
  });

  test("12.4 permission denied: 403 and NO challenge", async () => {
    const r = renderFailure(
      { kind: "forbidden", reason: "requires role admin" },
      { ...ctx, bodyStyle: "json" },
    );
    expect(r.status).toBe(403);
    expect(r.headers.has("www-authenticate")).toBe(false);
    expect(await r.json()).toEqual({
      error: "forbidden",
      error_description: "requires role admin",
    });
  });

  test("12.5 JWKS unavailable: 503, Retry-After 5, no challenge", async () => {
    const r = renderFailure({ kind: "jwks_unavailable", cause: new Error("boom") }, ctx);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.has("www-authenticate")).toBe(false);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "authorization keys unavailable, retry" },
      id: null,
    });
  });

  test("12.6 plain-API body for the 503 uses the `unavailable` code", async () => {
    const r = renderFailure(
      { kind: "jwks_unavailable", cause: undefined },
      { ...ctx, bodyStyle: "json" },
    );
    expect(await r.json()).toEqual({
      error: "unavailable",
      error_description: "authorization keys unavailable, retry",
    });
  });

  test("12.7 quoted-string escaping; control characters are refused", () => {
    expect(quoteAuthParam('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => quoteAuthParam("a\nb")).toThrow(TypeError);
    expect(quoteAuthParam("tab\tok")).toBe('"tab\tok"');
  });
});

describe("§12 end to end through a resource server", () => {
  async function setup() {
    const issuer = await createTestIssuer();
    const auth = mcpResource({ resource: RESOURCE, issuer: issuer.issuer, fetch: issuer.fetch });
    return { issuer, auth };
  }
  const request = (authorization?: string) =>
    new Request(RESOURCE, { headers: authorization === undefined ? {} : { authorization } });

  test("derives the RFC 9728 metadata URL from the resource", async () => {
    const { auth } = await setup();
    expect(auth.resourceMetadataUrl).toBe(PRM);
    expect(auth.resource).toBe(RESOURCE);
  });

  test("no token -> 12.1", async () => {
    const { auth } = await setup();
    const outcome = await auth.authenticate(request());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "missing_token" });
    expect(outcome.response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PRM}"`,
    );
  });

  test("token for another herkules resource -> 12.2 (audience binding)", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({ audience: "https://herkules.dev/mcp/directory-admin" });
    const outcome = await auth.authenticate(request(`Bearer ${token}`));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "invalid_token", reason: "wrong_audience" });
    expect(outcome.response.status).toBe(401);
    expect(outcome.response.headers.get("www-authenticate")).toContain(
      'error_description="invalid token"',
    );
  });

  test("expired token -> 12.2 'token expired'", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, expiresIn: -120 });
    const outcome = await auth.authenticate(request(`Bearer ${token}`));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "invalid_token", reason: "expired" });
    expect(outcome.response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM}", error_description="token expired"`,
    );
  });

  test("valid token -> principal", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({
      audience: RESOURCE,
      subject: "user_1",
      role: "admin",
      clientId: "ide_x",
    });
    const outcome = await auth.authenticate(request(`bearer ${token}`));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const p = outcome.principal;
    expect(p.subject).toBe("user_1");
    expect(p.role).toBe("admin");
    expect(p.clientId).toBe("ide_x");
    expect(p.resource).toBe(RESOURCE);
    expect(p.scopes.size).toBe(0);
    expect(p.token).toBe(token);
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(typeof p.tokenId).toBe("string");
    expect(Object.isFrozen(p)).toBe(true);
  });

  test("role requirement fails -> 12.4 (no challenge)", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, role: "member" });
    const outcome = await auth.authenticate(request(`Bearer ${token}`), { role: "admin" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "forbidden", reason: "requires role admin" });
    expect(outcome.response.status).toBe(403);
    expect(outcome.response.headers.has("www-authenticate")).toBe(false);
  });

  test("admin satisfies member", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, role: "admin" });
    expect((await auth.verifyToken(token, { role: "member" })).ok).toBe(true);
  });

  test("scope requirement -> 12.3 naming every missing scope", async () => {
    const issuer = await createTestIssuer();
    const auth = apiResource({
      resource: "https://herkules.dev/api/files",
      issuer: issuer.issuer,
      fetch: issuer.fetch,
      scopes: ["files:read", "files:write"],
    });
    const token = await issuer.mint({
      audience: "https://herkules.dev/api/files",
      scopes: ["offline_access"],
    });
    const outcome = await auth.verifyToken(token, { scopes: ["files:read", "files:write"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({
      kind: "insufficient_scope",
      missing: ["files:read", "files:write"],
    });
    expect(outcome.response.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="files:read files:write", resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/api/files", error_description="insufficient scope"`,
    );
    expect(auth.deny.scope("files:write").status).toBe(403);
  });

  test("deny.permission renders 12.4 with the caller's prose", async () => {
    const { auth } = await setup();
    const r = auth.deny.permission("not the owner");
    expect(r.status).toBe(403);
    expect(r.headers.has("www-authenticate")).toBe(false);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "not the owner" },
      id: null,
    });
  });

  test("issuer down before any key was cached -> 12.5, never 401", async () => {
    const { issuer, auth } = await setup();
    const token = await issuer.mint({ audience: RESOURCE });
    issuer.offline = true;
    const outcome = await auth.verifyToken(token);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("jwks_unavailable");
    expect(outcome.response.status).toBe(503);
    expect(outcome.response.headers.get("retry-after")).toBe("5");
  });
});
