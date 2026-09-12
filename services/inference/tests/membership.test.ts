import { afterEach, expect, test, vi } from "vite-plus/test";
import { Membership } from "../src/membership.ts";
import type { Config } from "../src/config.ts";
import type { NewAPI } from "../src/new-api.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let sub: string | undefined = "enabled-member";
  let status = 1;
  const admin = {
    bindings: async () => (sub ? [{ provider_slug: "herkules", provider_user_id: sub }] : []),
    users: async () => [{ id: 2, role: 1, status }],
    call: vi.fn(async () => {
      status = 2;
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const { ids } = JSON.parse(init.body) as { ids: string[] };
      return Response.json({ users: ids.map((id) => ({ id, enabled: id === "enabled-member" })) });
    }),
  );
  const membership = new Membership(
    { AUTH_INTERNAL_URL: "http://auth/auth", syncSecret: "test" } as Config,
    admin as unknown as NewAPI,
  );
  return {
    membership,
    admin,
    bind: (value?: string) => {
      sub = value;
    },
    enable: () => {
      status = 1;
    },
    disable: () => {
      status = 2;
    },
  };
}

test("a removed binding stays denied after reconciliation and administrator re-enable", async () => {
  const f = fixture();
  await f.membership.reconcile();
  expect(await f.membership.check(2)).toBe(true);
  f.bind();
  expect(await f.membership.check(2)).toBe(false);
  await f.membership.reconcile();
  expect(f.admin.call).toHaveBeenCalledWith("/api/user/manage", "POST", {
    id: 2,
    action: "disable",
  });
  f.enable();
  expect(await f.membership.check(2)).toBe(false);
  f.bind("enabled-member");
  expect(await f.membership.check(2)).toBe(true);
});

test("re-enabled accounts use their current binding after being skipped while disabled", async () => {
  const f = fixture();
  await f.membership.reconcile();
  expect(await f.membership.check(2)).toBe(true);
  f.disable();
  f.bind("disabled-member");
  await f.membership.reconcile();
  f.enable();
  expect(await f.membership.check(2)).toBe(false);
});
