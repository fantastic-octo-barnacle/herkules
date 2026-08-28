import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import { createTokenVerifier, parseAuthorization } from "../src/verify.ts";
import { createTestIssuer, type TestIssuer } from "../src/testing.ts";

const RESOURCE = "https://herkules.dev/mcp/directory";

async function setup(issuerOptions?: { issuer?: string }) {
  const issuer = await createTestIssuer(issuerOptions);
  const verifier = createTokenVerifier({
    issuer: issuer.issuer,
    resource: RESOURCE,
    jwksUrl: issuer.jwksUrl,
    clockToleranceSeconds: 60,
    fetch: issuer.fetch,
  });
  return { issuer, verifier };
}

async function expectInvalid(
  verifier: ReturnType<typeof createTokenVerifier>,
  token: string,
  reason: string,
): Promise<void> {
  const r = await verifier.verify(token);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.failure).toEqual({ kind: "invalid_token", reason });
}

/** Re-encode a compact JWS with a different protected header, keeping the (now wrong) signature. */
function withHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, sig] = token.split(".");
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  return `${h}.${payload}.${sig}`;
}

describe("parseAuthorization", () => {
  test.each([null, "", "   "])("absent or blank (%j) -> missing_token", (h) => {
    expect(parseAuthorization(h)).toEqual({ failure: { kind: "missing_token" } });
  });
  test.each(["Bearer", "Bearer ", "Basic abc", "DPoP abc", "Bearer a b", "abc"])(
    "%j -> malformed_authorization",
    (h) => {
      expect(parseAuthorization(h)).toEqual({ failure: { kind: "malformed_authorization" } });
    },
  );
  test.each(["Bearer abc", "bearer abc", "BEARER   abc  "])("%j -> token", (h) => {
    expect(parseAuthorization(h)).toEqual({ token: "abc" });
  });
});

describe("classification", () => {
  test("expired", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, expiresIn: -61 }),
      "expired",
    );
  });

  test("within clock tolerance is accepted", async () => {
    const { issuer, verifier } = await setup();
    expect(
      (await verifier.verify(await issuer.mint({ audience: RESOURCE, expiresIn: -30 }))).ok,
    ).toBe(true);
  });

  test("iat in the future -> not_yet_valid", async () => {
    const { issuer, verifier } = await setup();
    const future = Math.floor(Date.now() / 1000) + 600;
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, issuedAt: future }),
      "not_yet_valid",
    );
  });

  test("wrong issuer", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, issuer: "https://issuer.test/auth/" }),
      "wrong_issuer",
    );
  });

  test("wrong audience; array audience containing ours is accepted", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: ["https://other.test/x"] }),
      "wrong_audience",
    );
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: `${RESOURCE}/` }),
      "wrong_audience",
    );
    const arr = await issuer.mint({ audience: ["https://other.test/x", RESOURCE] });
    expect((await verifier.verify(arr)).ok).toBe(true);
  });

  test("wrong typ", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, typ: "JWT" }),
      "wrong_type",
    );
  });

  test("application/at+jwt is equivalent to at+jwt", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, typ: "application/at+jwt" });
    expect((await verifier.verify(token)).ok).toBe(true);
  });

  test("wrong alg (including none) is rejected before any key fetch", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE });
    await expectInvalid(
      verifier,
      withHeader(token, { alg: "none", typ: "at+jwt", kid: issuer.kid }),
      "wrong_algorithm",
    );
    await expectInvalid(
      verifier,
      withHeader(token, { alg: "HS256", typ: "at+jwt", kid: issuer.kid }),
      "wrong_algorithm",
    );
    expect(issuer.jwksFetches).toBe(0);
  });

  test("missing kid -> malformed, no key fetch", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE });
    await expectInvalid(verifier, withHeader(token, { alg: "EdDSA", typ: "at+jwt" }), "malformed");
    expect(issuer.jwksFetches).toBe(0);
  });

  test("unknown kid -> unknown_key (after one refetch)", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, signWith: "foreign" }),
      "unknown_key",
    );
    expect(issuer.jwksFetches).toBe(1);
  });

  test("tampered signature -> bad_signature", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE });
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    await expectInvalid(verifier, tampered, "bad_signature");
  });

  test("tampered payload -> bad_signature", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, role: "member" });
    const [h, p, s] = token.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    claims.role = "admin";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    await expectInvalid(verifier, forged, "bad_signature");
  });

  test("cnf present -> dpop_bound", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({ audience: RESOURCE, claims: { cnf: { jkt: "abc" } } });
    await expectInvalid(verifier, token, "dpop_bound");
  });

  test("missing role -> malformed (fail closed)", async () => {
    const { issuer, verifier } = await setup();
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, role: null }),
      "malformed",
    );
  });

  test("garbage -> malformed", async () => {
    const { verifier } = await setup();
    await expectInvalid(verifier, "not.a.jwt", "malformed");
    await expectInvalid(verifier, "abc", "malformed");
  });

  test("enriched claims cannot override AS-owned ones", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      audience: RESOURCE,
      subject: "real",
      claims: { sub: "forged", role: "admin", dept: "eng" },
    });
    const r = await verifier.verify(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.principal.subject).toBe("real");
    expect(r.principal.role).toBe("member");
    expect(r.principal.claims.dept).toBe("eng");
  });
});

describe("JWKS handling (§9)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function verifyOk(
    issuer: TestIssuer,
    verifier: ReturnType<typeof createTokenVerifier>,
    opts = {},
  ) {
    const r = await verifier.verify(await issuer.mint({ audience: RESOURCE, ...opts }));
    expect(r.ok).toBe(true);
  }

  test("the key set is fetched once and cached", async () => {
    const { issuer, verifier } = await setup();
    await verifyOk(issuer, verifier);
    await verifyOk(issuer, verifier);
    await verifyOk(issuer, verifier);
    expect(issuer.jwksFetches).toBe(1);
  });

  test("two verifiers never share key state", async () => {
    const issuer = await createTestIssuer();
    const make = () =>
      createTokenVerifier({
        issuer: issuer.issuer,
        resource: RESOURCE,
        jwksUrl: issuer.jwksUrl,
        clockToleranceSeconds: 60,
        fetch: issuer.fetch,
      });
    await verifyOk(issuer, make());
    await verifyOk(issuer, make());
    expect(issuer.jwksFetches).toBe(2);
  });

  test("rotation: a new kid triggers one refetch; the retired key still verifies during grace", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { issuer, verifier } = await setup();
    await verifyOk(issuer, verifier);
    await issuer.rotate();
    vi.advanceTimersByTime(31_000); // past the 30 s cooldown
    await verifyOk(issuer, verifier); // new kid -> refetch
    expect(issuer.jwksFetches).toBe(2);
    await verifyOk(issuer, verifier, { signWith: "retired" });
    expect(issuer.jwksFetches).toBe(2);
  });

  test("an unknown kid is not refetched more than once per 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { issuer, verifier } = await setup();
    await verifyOk(issuer, verifier);
    expect(issuer.jwksFetches).toBe(1);
    const foreign = await issuer.mint({ audience: RESOURCE, signWith: "foreign" });
    await expectInvalid(verifier, foreign, "unknown_key");
    expect(issuer.jwksFetches).toBe(1); // inside cooldown: no refetch
    vi.advanceTimersByTime(31_000);
    await expectInvalid(verifier, foreign, "unknown_key");
    expect(issuer.jwksFetches).toBe(2); // cooldown elapsed: exactly one refetch
  });

  test("after the grace period a retired key is rejected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { issuer, verifier } = await setup();
    await issuer.rotate();
    const old = await issuer.mint({ audience: RESOURCE, signWith: "retired" });
    issuer.retireOldKeys();
    vi.advanceTimersByTime(31_000);
    await expectInvalid(verifier, old, "unknown_key");
  });

  test("issuer down after the cache went stale: the stale set is used, not a 503", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { issuer, verifier } = await setup();
    await verifyOk(issuer, verifier);
    vi.advanceTimersByTime(6 * 60_000); // past cacheMaxAge
    issuer.offline = true;
    await verifyOk(issuer, verifier);
    await expectInvalid(
      verifier,
      await issuer.mint({ audience: RESOURCE, signWith: "foreign" }),
      "unknown_key",
    );
  });

  test("a non-200 JWKS response is unavailable, not invalid_token", async () => {
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({
      issuer: issuer.issuer,
      resource: RESOURCE,
      jwksUrl: `${issuer.issuer}/nope`,
      clockToleranceSeconds: 60,
      fetch: issuer.fetch,
    });
    const r = await verifier.verify(await issuer.mint({ audience: RESOURCE }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe("jwks_unavailable");
  });

  test("the JWKS transport is asked not to follow redirects", async () => {
    const seen: RequestInit[] = [];
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({
      issuer: issuer.issuer,
      resource: RESOURCE,
      jwksUrl: issuer.jwksUrl,
      clockToleranceSeconds: 60,
      fetch: (input, init) => {
        seen.push(init ?? {});
        return issuer.fetch(input, init);
      },
    });
    await verifyOk(issuer, verifier);
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("clock tolerance above 300 s is a boot error", async () => {
    const issuer = await createTestIssuer();
    expect(() =>
      createTokenVerifier({
        issuer: issuer.issuer,
        resource: RESOURCE,
        jwksUrl: issuer.jwksUrl,
        clockToleranceSeconds: 301,
        fetch: issuer.fetch,
      }),
    ).toThrow(TypeError);
  });
});
