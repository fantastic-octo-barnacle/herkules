import { mcpResource } from "@herkules/auth-middleware";
import { fetchVia } from "@herkules/auth-middleware/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

let t: TestService;
beforeAll(async () => {
  t = await createTestService();
  t.github.user({ id: 1001, login: "alice", name: "Alice", org: "active" });
});
afterAll(() => t.close());

describe("discovery", () => {
  test("healthz", async () => {
    const res = await t.fetch("/auth/healthz");
    expect(res.status).toBe(200);
  });
  test("AS metadata at the RFC 8414 path-inserted alias and under /auth", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/auth",
      "/auth/.well-known/oauth-authorization-server",
    ]) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(t.issuer);
      expect(body.jwks_uri).toBe(`${t.issuer}/jwks`);
      expect(body.registration_endpoint).toBe(`${t.issuer}/oauth2/register`);
    }
  });
  test("JWKS has an Ed25519 key", async () => {
    const res = await t.fetch("/auth/jwks");
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as {
      keys: { kty: string; crv: string; kid: string; alg: string }[];
    };
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" }),
        expect.objectContaining({ kty: "EC", crv: "P-256", alg: "ES256" }),
      ]),
    );
  });
  test("PRM for every registry entry", async () => {
    for (const e of t.service.registry.entries) {
      const res = await t.fetch(e.metadataUrl);
      expect(res.status, e.name).toBe(200);
      expect(await res.json()).toEqual({
        resource: e.audience,
        authorization_servers: [t.issuer],
        bearer_methods_supported: ["header"],
        dpop_signing_alg_values_supported: expect.any(Array),
        scopes_supported: ["offline_access"],
        resource_name: e.title,
      });
    }
    expect((await t.fetch("/.well-known/oauth-protected-resource/mcp/nope")).status).toBe(404);
  });
});

describe("login and token", () => {
  test("org member logs in, gets a token for BBS MCP, middleware verifies it", async () => {
    const login = await t.login("alice");
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const audience = t.service.registry.canonical.audience;
    const client = await t.mcpClient(login.cookie, audience);
    expect(client.refreshToken).not.toBe("");

    const auth = mcpResource({ resource: audience, issuer: t.issuer, fetch: fetchVia(t.app) });
    const outcome = await auth.verifyToken(client.accessToken);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.principal.subject).toBe(login.userId);
    expect(outcome.principal.role).toBe("member");
    expect(outcome.principal.clientId).toBe(client.clientId);
    expect([...outcome.principal.scopes]).toEqual(["offline_access"]);
    expect(outcome.principal.claims.aud).toBe(audience); // a plain string: no openid, no userinfo audience

    // Audience binding: the same token is refused by the other resource.
    const notes = t.service.registry.entries.find((e) => e.name === "notes")!;
    const other = mcpResource({
      resource: notes.audience,
      issuer: t.issuer,
      fetch: auth["fetch" as never] ?? undefined,
    });
    void other;

    const types = (await t.audit()).map((r) => r.type);
    expect(types).toContain("login");
    expect(types).toContain("client.registered");
    expect(types).toContain("consent.granted");
    expect(types).toContain("token.issued");
  });
});
