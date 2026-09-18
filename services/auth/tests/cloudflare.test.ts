import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { ensureSigningKeys } from "../src/signing.ts";
import { createTestService, type TestService } from "../src/testing.ts";

const secret = "cloudflare-test-secret".padEnd(48, "x");
const callback = "https://team-test.cloudflareaccess.com/cdn-cgi/access/callback";
describe("Cloudflare Access", () => {
  let t: TestService;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestService({
      env: {
        CLOUDFLARE_TEAM_NAME: "team-test",
        CLOUDFLARE_CLIENT_SECRET: secret,
      },
    });
    t.github.user({ id: 7, login: "alice", org: "active" });
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    cookie = login.cookie;
  });
  afterAll(() => t.close());

  async function exchange(scope = "openid email profile", validVerifier = true) {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "cloudflare-access",
      redirect_uri: callback,
      scope,
      state: "state",
      nonce: "nonce",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authz = await t.app.request(`${t.issuer}/oauth2/authorize?${params.toString()}`, {
      headers: { cookie },
    });
    expect(authz.status).toBe(302);
    const redirect = new URL(authz.headers.get("location")!, t.origin);
    expect(redirect.origin + redirect.pathname).toBe(callback);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    return t.app.request(`${t.issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`cloudflare-access:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: callback,
        code_verifier: validVerifier ? verifier : "wrong".padEnd(43, "x"),
      }).toString(),
    });
  }

  test("seed requires PKCE and restricts the callback", async () => {
    expect(await t.service.db.clients.byId("cloudflare-access")).toMatchObject({
      requirePKCE: true,
      redirectUris: [callback],
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect((await exchange("openid email", false)).status).toBe(401);
  });

  test("ES256 ID token contains email, nonce and a valid access-token hash", async () => {
    const res = await exchange();
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { id_token: string; access_token: string };
    const { payload } = await jwtVerify(
      tokens.id_token,
      createLocalJWKSet(await t.service.auth.api.getJwks()),
      {
        issuer: t.issuer,
        audience: "cloudflare-access",
        algorithms: ["ES256"],
      },
    );
    expect(payload).toMatchObject({
      email: "alice@example.com",
      email_verified: true,
      nonce: "nonce",
    });
    expect(payload.at_hash).toBe(
      createHash("sha256")
        .update(tokens.access_token)
        .digest()
        .subarray(0, 16)
        .toString("base64url"),
    );
  });

  test("does not disclose email without its scope", async () => {
    const res = await exchange("openid");
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { id_token: string };
    expect(decodeJwt(tokens.id_token).email).toBeUndefined();
  });

  test("migration from an EdDSA-only key store preserves outstanding resource tokens", async () => {
    const session = await t.mcpClient(cookie, t.service.registry.canonical.audience);
    expect(decodeProtectedHeader(session.accessToken).alg).toBe("EdDSA");
    const context = await t.service.auth.$context;
    // Simulate the production key store before the ES256 migration.
    await context.adapter.deleteMany({ model: "jwks", where: [{ field: "alg", value: "ES256" }] });
    await ensureSigningKeys(t.service.auth, t.issuer);
    const keys = await t.service.auth.api.getJwks();
    await ensureSigningKeys(t.service.auth, t.issuer);
    expect((await t.service.auth.api.getJwks()).keys).toEqual(keys.keys);
    await jwtVerify(session.accessToken, createLocalJWKSet(keys), {
      issuer: t.issuer,
      audience: t.service.registry.canonical.audience,
      algorithms: ["EdDSA"],
    });
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(decodeProtectedHeader(((await res.json()) as { id_token: string }).id_token).alg).toBe(
      "ES256",
    );
    expect((await session.refresh()).status).toBe(200);
    expect(decodeProtectedHeader(session.accessToken).alg).toBe("EdDSA");
  });
});
