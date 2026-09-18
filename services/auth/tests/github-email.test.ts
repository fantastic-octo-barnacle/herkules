import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

describe("GitHub requires a real verified email", () => {
  let t: TestService;
  beforeAll(async () => {
    t = await createTestService({ adminLogins: ["email-admin"] });
  });
  afterAll(() => t.close());
  test("private verified email is used instead of a synthetic address", async () => {
    t.github.user({
      id: 810,
      login: "private-email",
      org: "active",
      email: null,
      emails: [{ email: "private@example.com", verified: true, primary: true }],
    });
    const r = await t.login("private-email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await t.service.db.users.byId(r.userId)).toMatchObject({
      email: "private@example.com",
      emailVerified: true,
    });
  });
  test("verified primary is preferred; verified secondary works when primary is unverified", async () => {
    for (const verified of [true, false]) {
      const name = `primary-${verified}`;
      t.github.user({
        id: verified ? 811 : 812,
        login: name,
        org: "active",
        emails: [
          { email: "secondary-" + name + "@example.com", verified: true, primary: false },
          { email: name + "@example.com", verified, primary: true },
        ],
      });
      const r = await t.login(name);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((await t.service.db.users.byId(r.userId))?.email).toBe(
        `${verified ? "" : "secondary-"}${name}@example.com`,
      );
    }
  });
  test.each(
    [
      [],
      [{ email: "unverified@example.com", verified: false, primary: true }],
      [{ email: "bad", verified: true, primary: true }],
      [{ email: "814+someone@users.noreply.github.com", verified: true, primary: true }],
    ].map((emails) => ({ emails })),
  )(
    "missing, unverified, malformed and noreply addresses fail before provisioning: %j",
    async ({ emails }) => {
      t.github.user({
        id: 813,
        login: "missing-email",
        org: "active",
        email: "public@example.com",
        emails,
      });
      expect(await t.login("missing-email")).toMatchObject({ ok: false });
      expect(await t.service.db.users.byGithubId("813")).toBeUndefined();
    },
  );
  test("unreadable email endpoint rejects login even with a public email", async () => {
    t.github.user({
      id: 814,
      login: "email-forbidden",
      org: "active",
      email: "public@example.com",
    });
    t.github.fail("revoked", 1, /\/user\/emails/);
    expect(await t.login("email-forbidden")).toMatchObject({ ok: false });
    expect(await t.service.db.users.byGithubId("814")).toBeUndefined();
  });
  test("returning, allowlisted and environment-admin logins cannot fall back to a stored email", async () => {
    t.github.user({ id: 815, login: "returning-email", org: "active" });
    expect(await t.login("returning-email")).toMatchObject({ ok: true });
    t.github.user({ id: 815, login: "returning-email", org: "active", emails: [] });
    expect(await t.login("returning-email")).toMatchObject({ ok: false });
    await t.service.users.allowlistAdd({ kind: "system", job: "test" }, "allow-email");
    t.github.user({ id: 816, login: "allow-email", org: "none", emails: [] });
    t.github.user({ id: 817, login: "email-admin", org: "none", emails: [] });
    expect(await t.login("allow-email")).toMatchObject({ ok: false });
    expect(await t.login("email-admin")).toMatchObject({ ok: false });
  });
});
