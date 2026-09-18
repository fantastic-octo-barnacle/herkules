import { afterEach, expect, test, vi } from "vite-plus/test";
import { Membership, VERDICT_TTL } from "../src/membership.ts";
import type { Config } from "../src/config.ts";
import type { NewAPI } from "../src/new-api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(accounts = [{ id: 2, role: 1, status: 1 }]) {
  let sub: string | undefined = "enabled-member";
  const enabled = new Set(["enabled-member"]);
  const admin = {
    bindings: vi.fn(async (id: number) =>
      id === 2
        ? sub
          ? [{ provider_slug: "herkules", provider_user_id: sub }]
          : []
        : [{ provider_slug: "herkules", provider_user_id: `member-${id}` }],
    ),
    users: async () => accounts,
    call: vi.fn(async (_path: string, _method: string, value: { id: number }) => {
      accounts.find((a) => a.id === value.id)!.status = 2;
    }),
  };
  const status = vi.fn(async (_url: string, init: { body: string }) => {
    const { ids } = JSON.parse(init.body) as { ids: string[] };
    return Response.json({ users: ids.map((id) => ({ id, enabled: enabled.has(id) })) });
  });
  vi.stubGlobal("fetch", status);
  const membership = new Membership(
    { AUTH_INTERNAL_URL: "http://auth/auth", syncSecret: "test" } as Config,
    admin as unknown as NewAPI,
  );
  return {
    membership,
    admin,
    status,
    accounts,
    enabled,
    bind: (value?: string) => {
      sub = value;
    },
  };
}

test("a removed binding stays denied after reconciliation and administrator re-enable", async () => {
  const f = fixture();
  await f.membership.reconcile();
  expect(await f.membership.check(2)).toBe(true);
  f.bind();
  await f.membership.reconcile();
  expect(f.admin.call).toHaveBeenCalledWith("/api/user/manage", "POST", {
    id: 2,
    action: "disable",
  });
  f.accounts[0].status = 1;
  expect(await f.membership.check(2)).toBe(false);
  f.bind("enabled-member");
  expect(await f.membership.check(2)).toBe(true);
});

test("re-enabled accounts use their current binding after being skipped while disabled", async () => {
  const f = fixture();
  await f.membership.reconcile();
  expect(await f.membership.check(2)).toBe(true);
  f.accounts[0].status = 2;
  f.bind("disabled-member");
  await f.membership.reconcile();
  f.accounts[0].status = 1;
  expect(await f.membership.check(2)).toBe(false);
});

test("an admitted verdict is reused until it expires, bounding revocation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  await f.membership.reconcile();
  f.admin.bindings.mockClear();
  f.status.mockClear();
  expect(await Promise.all([f.membership.check(2), f.membership.check(2)])).toEqual([true, true]);
  expect(f.admin.bindings).not.toHaveBeenCalled();
  expect(f.status).not.toHaveBeenCalled();
  f.enabled.delete("enabled-member");
  vi.setSystemTime(Date.now() + VERDICT_TTL - 1);
  expect(await f.membership.check(2)).toBe(true);
  vi.setSystemTime(Date.now() + 1);
  expect(await f.membership.check(2)).toBe(false);
  expect(f.status).toHaveBeenCalledTimes(1);
});

test("denials are not cached; concurrent cold checks share one upstream read", async () => {
  const f = fixture();
  f.enabled.clear();
  await f.membership.reconcile();
  f.accounts[0].status = 1;
  f.status.mockClear();
  expect(await f.membership.check(2)).toBe(false);
  f.enabled.add("enabled-member");
  expect(await Promise.all([f.membership.check(2), f.membership.check(2)])).toEqual([true, true]);
  expect(f.status).toHaveBeenCalledTimes(2);
});

test("reconciliation batches status reads and bounds binding concurrency", async () => {
  const accounts = Array.from({ length: 205 }, (_, i) => ({ id: i + 3, role: 1, status: 1 }));
  const f = fixture(accounts);
  let active = 0;
  let peak = 0;
  const bindings = f.admin.bindings.getMockImplementation()!;
  f.admin.bindings.mockImplementation(async (id) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return bindings(id);
  });
  for (const a of accounts) f.enabled.add(`member-${a.id}`);
  await f.membership.reconcile();
  expect(peak).toBe(5);
  expect(f.status.mock.calls.map(([, init]) => JSON.parse(init.body).ids.length)).toEqual([
    100, 100, 5,
  ]);
  expect(f.admin.call).not.toHaveBeenCalled();
  f.status.mockClear();
  expect(await f.membership.check(3)).toBe(true);
  expect(f.status).not.toHaveBeenCalled();
});
