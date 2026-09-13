/**
 * Integration: Client ID Metadata Documents (draft-02, MCP 2026-07-28 profile)
 * behind CIMD_ENABLED. The document is what Claude Code publishes: a port-less
 * `http://localhost/callback`, authorized on a per-run ephemeral port. That
 * relies on oauth-provider >= 1.7.3 granting RFC 8252 port variance to
 * `localhost` (it was 127.0.0.1/[::1] only before, see docs/auth.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

const CLIENT_ID = "https://cimd.example.com/oauth/claude-code.json";
const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: "Claude Code",
  client_uri: "https://cimd.example.com",
  redirect_uris: ["http://localhost/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const PORTED_REDIRECT = "http://localhost:54321/callback";

/** GET /oauth2/authorize only: the status and Location the AS answers with, for negative cases. */
async function authorize(
  t: TestService,
  cookie: string,
  clientId: string,
  redirectUri: string,
): Promise<{ status: number; location: string; body: string }> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "offline_access",
    resource: `${t.origin}/mcp/bbs`,
    state: "s123",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });
  const res = await t.fetch(`/auth/oauth2/authorize?${q.toString()}`, { cookie });
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    body: await res.text(),
  };
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
}

describe("CIMD enabled", () => {
  let t: TestService;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestService({ cimd: { [CLIENT_ID]: DOCUMENT } });
    t.github.user({ id: 1, login: "alice", org: "active" });
    const r = await t.login("alice");
    if (!r.ok) throw new Error(`login failed: ${r.error}`);
    cookie = r.cookie;
  });
  afterAll(() => t.close());

  test("the AS metadata advertises CIMD beside DCR", async () => {
    const res = await t.fetch("/.well-known/oauth-authorization-server/auth");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(typeof meta.registration_endpoint).toBe("string");
  });

  test("a port-less localhost document authorizes on an ephemeral port; the token is bound to the requested resource and the registration is audited", async () => {
    const audience = `${t.origin}/mcp/bbs`;
    const session = await t.mcpClient(cookie, audience, {
      clientId: CLIENT_ID,
      redirectUri: PORTED_REDIRECT,
    });
    const claims = claimsOf(session.accessToken);
    expect(claims.aud).toBe(audience);
    expect(claims.client_id).toBe(CLIENT_ID);
    expect(claims.role).toBe("member");

    const registered = (await t.audit()).filter((e) => e.type === "client.registered");
    expect(registered.at(-1)?.event).toMatchObject({
      clientId: CLIENT_ID,
      name: "Claude Code",
      redirectUris: ["http://localhost/callback"],
      discovery: "cimd",
    });

    const refreshed = await session.refresh();
    expect(refreshed.status).toBe(200);
  });

  test("only the port may vary: another loopback host or path is refused", async () => {
    for (const redirectUri of [
      "http://127.0.0.1:54321/callback",
      "http://localhost:54321/other",
      "https://attacker.example/callback",
    ]) {
      const r = await authorize(t, cookie, CLIENT_ID, redirectUri);
      expect(r.status).toBe(302);
      expect(r.location).toMatch(/^\/login\?error=invalid_redirect/);
    }
  });

  test("an unknown document URL is refused as an invalid client", async () => {
    const r = await authorize(
      t,
      cookie,
      "https://cimd.example.com/oauth/missing.json",
      PORTED_REDIRECT,
    );
    expect(r.status).toBe(400); // no registered client to redirect to: the AS answers the caller directly
    expect(r.body).toMatch(/invalid_client/);
  });
});

describe("CIMD origin allowlist", () => {
  let t: TestService;
  beforeAll(async () => {
    t = await createTestService({
      cimd: { [CLIENT_ID]: DOCUMENT },
      env: { CIMD_ALLOWED_ORIGINS: "https://claude.ai, https://chatgpt.com" },
    });
    t.github.user({ id: 1, login: "alice", org: "active" });
  });
  afterAll(() => t.close());

  test("a document from an origin outside the allowlist is never fetched", async () => {
    const r = await t.login("alice");
    if (!r.ok) throw new Error(`login failed: ${r.error}`);
    const a = await authorize(t, r.cookie, CLIENT_ID, PORTED_REDIRECT);
    expect(a.status).toBe(400);
    expect(a.body).toMatch(/invalid_client/);
    expect((await t.audit()).some((e) => e.type === "client.registered")).toBe(false);
  });
});

describe("CIMD disabled (the default)", () => {
  let t: TestService;
  beforeAll(async () => {
    t = await createTestService();
    t.github.user({ id: 1, login: "alice", org: "active" });
  });
  afterAll(() => t.close());

  test("the metadata does not advertise CIMD and a URL client_id is an unknown client", async () => {
    const meta = (await (
      await t.fetch("/.well-known/oauth-authorization-server/auth")
    ).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).not.toBe(true);
    const r = await t.login("alice");
    if (!r.ok) throw new Error(`login failed: ${r.error}`);
    const a = await authorize(t, r.cookie, CLIENT_ID, PORTED_REDIRECT);
    expect(a.status).toBe(302);
    expect(a.location).toMatch(/^\/login\?error=invalid_client/);
  });
});
