import { describe, expect, test } from "vite-plus/test";
import { decide, gateUserRowOf, isStamped, type Evidence } from "../src/gate.ts";

const now = new Date("2026-08-28T10:00:00Z");
const base: Evidence = {
  login: "alice",
  envAdmin: false,
  allowlisted: false,
  banned: false,
  org: "active",
  phase: "login",
  now,
  staleMaxSeconds: 86_400,
};
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("decide", () => {
  test("precedence: banned > envAdmin > allowlist > org", () => {
    expect(decide({ ...base, banned: true, envAdmin: true, allowlisted: true })).toEqual({
      ok: false,
      reason: "banned",
    });
    expect(decide({ ...base, envAdmin: true, allowlisted: true, org: "none" })).toEqual({
      ok: true,
      via: "admin",
    });
    expect(decide({ ...base, allowlisted: true, org: "none" })).toEqual({
      ok: true,
      via: "allowlist",
    });
    expect(decide({ ...base, allowlisted: true, org: "unknown" })).toEqual({
      ok: true,
      via: "allowlist",
    });
    expect(decide(base)).toEqual({ ok: true, via: "org" });
  });

  test("org outcomes", () => {
    expect(decide({ ...base, org: "none" })).toEqual({ ok: false, reason: "not_org_member" });
    expect(decide({ ...base, org: "revoked", phase: "grant" })).toEqual({
      ok: false,
      reason: "github_token_revoked",
    });
  });

  test("GitHub unknown at login fails closed, even with a prior allow", () => {
    expect(decide({ ...base, org: "unknown", prior: { via: "org", checkedAt: ago(10) } })).toEqual({
      ok: false,
      reason: "github_unreachable",
    });
  });

  test("GitHub unknown at grant keeps a prior allow within staleMax as org-stale", () => {
    const grant: Evidence = { ...base, phase: "grant", org: "unknown" };
    expect(decide({ ...grant, prior: { via: "org", checkedAt: ago(3600) } })).toEqual({
      ok: true,
      via: "org-stale",
    });
    expect(decide({ ...grant, prior: { via: "org-stale", checkedAt: ago(86_400) } })).toEqual({
      ok: true,
      via: "org-stale",
    });
    expect(decide({ ...grant, prior: { via: "org", checkedAt: ago(86_401) } })).toEqual({
      ok: false,
      reason: "github_unreachable",
    });
    expect(decide(grant)).toEqual({ ok: false, reason: "github_unreachable" });
  });
});

test("isStamped", () => {
  const stamp = { verdict: { ok: true, via: "org" }, checkedAt: 1 };
  expect(isStamped({ id: 1, login: "a", herkules: stamp })).toBe(true);
  expect(
    isStamped({
      id: 1,
      login: "a",
      herkules: { verdict: { ok: false, reason: "banned" }, checkedAt: 1 },
    }),
  ).toBe(true);
  expect(isStamped({ id: 1, login: "a" })).toBe(false);
  expect(
    isStamped({
      id: 1,
      login: "a",
      herkules: { verdict: { ok: true, via: "root" }, checkedAt: 1 },
    }),
  ).toBe(false);
  expect(isStamped(null)).toBe(false);
});

test("gateUserRowOf", () => {
  expect(
    gateUserRowOf({
      id: "u",
      githubLogin: "a",
      banned: null,
      admittedVia: "org",
      gateCheckedAt: 5,
    }),
  ).toEqual({
    id: "u",
    githubLogin: "a",
    feishuTenantKey: null,
    feishuOpenId: null,
    banned: false,
    admittedVia: "org",
    gateCheckedAt: 5,
  });
  expect(gateUserRowOf({ id: "u", githubLogin: "a", admittedVia: "weird" }).admittedVia).toBeNull();
  expect(() => gateUserRowOf({ id: "u" })).toThrow(/githubLogin/);
});
