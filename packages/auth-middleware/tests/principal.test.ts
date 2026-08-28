import { describe, expect, test } from "vite-plus/test";
import { MalformedClaimsError, principalFromClaims, roleSatisfies } from "../src/principal.ts";

const RESOURCE = "https://herkules.dev/mcp/directory";
const base = {
  iss: "https://herkules.dev/auth",
  sub: "u1",
  aud: RESOURCE,
  client_id: "c1",
  role: "member",
  iat: 1_700_000_000,
  exp: 1_700_000_900,
  jti: "j1",
};

describe("principalFromClaims", () => {
  test("maps every claim", () => {
    const p = principalFromClaims({ ...base, scope: "a b", sid: "s1" }, "tok", RESOURCE);
    expect(p).toMatchObject({
      subject: "u1",
      clientId: "c1",
      role: "member",
      resource: RESOURCE,
      tokenId: "j1",
      sessionId: "s1",
      token: "tok",
    });
    expect([...p.scopes]).toEqual(["a", "b"]);
    expect(p.issuedAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(p.expiresAt.getTime() - p.issuedAt.getTime()).toBe(900_000);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.claims)).toBe(true);
    expect("sessionId" in principalFromClaims(base, "t", RESOURCE)).toBe(false);
  });

  test("azp is the client_id fallback", () => {
    const { client_id: _omit, ...rest } = base;
    expect(principalFromClaims({ ...rest, azp: "c2" }, "t", RESOURCE).clientId).toBe("c2");
  });

  test.each([
    ["sub", { sub: "" }],
    ["aud", { aud: "https://herkules.dev/mcp/other" }],
    ["aud", { aud: ["https://herkules.dev/mcp/other"] }],
    ["role", { role: "owner" }],
    ["role", { role: undefined }],
    ["client_id", { client_id: undefined }],
    ["jti", { jti: 5 }],
    ["iat", { iat: "1" }],
    ["exp", { exp: Number.NaN }],
    ["scope", { scope: 'a"b' }],
    ["scope", { scope: ["a"] }],
    ["sid", { sid: 1 }],
  ])("rejects a bad %s claim", (claim, patch) => {
    expect(() => principalFromClaims({ ...base, ...patch }, "t", RESOURCE)).toThrow(
      expect.objectContaining({ claim }) as MalformedClaimsError,
    );
  });

  test("empty and absent scope are the same empty set", () => {
    expect(principalFromClaims({ ...base, scope: "" }, "t", RESOURCE).scopes.size).toBe(0);
    expect(principalFromClaims(base, "t", RESOURCE).scopes.size).toBe(0);
  });
});

test("roleSatisfies", () => {
  expect(roleSatisfies("admin", "member")).toBe(true);
  expect(roleSatisfies("admin", "admin")).toBe(true);
  expect(roleSatisfies("member", "member")).toBe(true);
  expect(roleSatisfies("member", "admin")).toBe(false);
});
