import { expect, test } from "vite-plus/test";
import { principalOf, toAuthInfo } from "../src/mcp.ts";
import { principalFromClaims } from "../src/principal.ts";

const RESOURCE = "https://herkules.dev/mcp/directory";

test("toAuthInfo / principalOf round-trip", () => {
  const p = principalFromClaims(
    {
      sub: "u1",
      aud: RESOURCE,
      client_id: "c1",
      role: "admin",
      iat: 1,
      exp: 901,
      jti: "j",
      scope: "offline_access",
    },
    "tok",
    RESOURCE,
  );
  const info = toAuthInfo(p);
  expect(info).toMatchObject({
    token: "tok",
    clientId: "c1",
    scopes: ["offline_access"],
    expiresAt: 901,
  });
  expect(info.resource?.href).toBe(RESOURCE);
  expect(principalOf(info)).toBe(p);
});

test("principalOf rejects authInfo not built by toAuthInfo", () => {
  expect(() => principalOf({ token: "t", clientId: "c", scopes: [] })).toThrow(/toAuthInfo/);
  expect(() => principalOf(undefined)).toThrow();
});
