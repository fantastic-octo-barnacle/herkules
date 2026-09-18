import { afterEach, expect, test, vi } from "vite-plus/test";
import { Plans } from "../src/plans.ts";
import type { NewAPI } from "../src/new-api.ts";
function fixture() {
  const catalog: { id: number; title: string; total_amount: number; herkules_pool: string }[] = [];
  const subs: {
    id: number;
    plan_id: number;
    amount_total: number;
    amount_used: number;
    status: string;
    end_time: number;
    next_reset_time: number;
  }[] = [];
  let grants = 0;
  const admin = {
    call: async (
      path: string,
      method = "GET",
      value?: { plan?: (typeof catalog)[number]; plan_id?: number },
    ) => {
      if (path === "/api/subscription/admin/plans") {
        if (method === "GET") return catalog.map((plan) => ({ plan }));
        const plan = { ...value!.plan!, id: catalog.length + 1 };
        catalog.push(plan);
        return plan;
      }
      if (path.endsWith("/invalidate")) {
        subs.find((s) => path.includes(`/${s.id}/`))!.status = "cancelled";
        return;
      }
      if (method === "GET") return subs.map((subscription) => ({ subscription }));
      grants++;
      const p = catalog.find((p) => p.id === value!.plan_id)!;
      subs.push({
        id: 100 + grants,
        plan_id: p.id,
        amount_total: p.total_amount,
        amount_used: 0,
        status: "active",
        end_time: Date.now() / 1000 + 3600,
        next_reset_time: Date.now() / 1000 + 1800,
      });
    },
  } as unknown as NewAPI;
  return { plans: new Plans(admin), admin, catalog, subs, grants: () => grants };
}
afterEach(() => {
  vi.useRealTimers();
});
test("recently ensured users skip the subscription read until assignment invalidates them", async () => {
  const f = fixture();
  await f.plans.bootstrap();
  const call = vi.spyOn(f.admin, "call");
  const reads = () =>
    call.mock.calls.filter(([path, method]) => path.endsWith("/subscriptions") && !method).length;
  await Promise.all([f.plans.ensure(2), f.plans.ensure(2), f.plans.ensure(2)]);
  await f.plans.ensure(2);
  expect(reads()).toBe(1);
  await f.plans.assign(2, "pro");
  expect(reads()).toBe(2);
  f.subs.forEach((s) => (s.status = "cancelled"));
  await f.plans.ensure(2);
  expect(reads()).toBe(3);
  expect(f.grants()).toBe(4);
});
test("a failed assignment still invalidates the recent check", async () => {
  const f = fixture();
  await f.plans.bootstrap();
  await f.plans.ensure(2);
  const original = f.admin.call.bind(f.admin);
  const call = vi.spyOn(f.admin, "call").mockImplementation(async (path, method, value) => {
    if (method === "POST" && path.endsWith("/subscriptions")) throw new Error("injected failure");
    return original(path, method, value);
  });
  await expect(f.plans.assign(2, "pro")).rejects.toThrow("injected failure");
  call.mockClear();
  await f.plans.ensure(2);
  expect(call).toHaveBeenCalledWith("/api/subscription/admin/users/2/subscriptions");
});
test("concurrent first requests grant one Lite pair; repeat assignments preserve usage", async () => {
  const f = fixture();
  await f.plans.bootstrap();
  await f.plans.bootstrap();
  expect(f.catalog).toHaveLength(6);
  await Promise.all([f.plans.ensure(2), f.plans.ensure(2)]);
  expect(f.grants()).toBe(2);
  f.subs[0].amount_used = 123;
  await f.plans.assign(2, "lite");
  expect(f.grants()).toBe(2);
  expect((await f.plans.summary(2)).pools[0].remaining).toBe(999877);
});
test("cancelled plans are not automatically refilled; upgrades replace both pools", async () => {
  const f = fixture();
  await f.plans.bootstrap();
  await f.plans.ensure(2);
  await f.plans.assign(2, "pro");
  expect((await f.plans.summary(2)).pools.map((p) => p.total)).toEqual([5000000, 5000000]);
  f.subs.forEach((s) => (s.status = "cancelled"));
  await f.plans.ensure(2);
  expect(f.grants()).toBe(4);
  await expect(f.plans.assign(2, "constructor" as "lite")).rejects.toThrow();
});

test("an active pair repairs a cancelled counterpart without resetting its other pool", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  await f.plans.bootstrap();
  await f.plans.ensure(2);
  f.subs[0].amount_used = 123;
  f.subs[1].status = "cancelled";
  // An out-of-process cancellation is repaired once the recent check expires.
  await f.plans.ensure(2);
  expect(f.grants()).toBe(2);
  vi.setSystemTime(Date.now() + 5 * 60_000);
  await f.plans.ensure(2);
  await f.plans.ensure(2);
  expect(f.grants()).toBe(3);
  expect(f.subs[0].amount_used).toBe(123);
  expect((await f.plans.summary(2)).pools).toHaveLength(2);
});
for (const failure of [
  "first grant",
  "second grant",
  "first cancellation",
  "second cancellation",
]) {
  test(`tier assignment recovers from ${failure} without losing allowances or repeating grants`, async () => {
    const f = fixture();
    await f.plans.bootstrap();
    await f.plans.ensure(2);
    const original = f.admin.call.bind(f.admin);
    let grants = 0;
    let cancels = 0;
    const spy = vi.spyOn(f.admin, "call").mockImplementation(async (path, method, value) => {
      if (method === "POST" && path.endsWith("/subscriptions")) {
        grants++;
        if (failure === (grants === 1 ? "first grant" : "second grant"))
          throw new Error("injected failure");
      }
      if (path.endsWith("/invalidate")) {
        cancels++;
        if (failure === (cancels === 1 ? "first cancellation" : "second cancellation"))
          throw new Error("injected failure");
      }
      return original(path, method, value);
    });
    await expect(f.plans.assign(2, "pro")).rejects.toThrow("injected failure");
    expect((await f.plans.summary(2)).pools.length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
    const count = f.grants();
    await f.plans.ensure(2);
    expect(f.grants()).toBe(count);
    for (const s of f.subs) s.amount_used = 123;
    await f.plans.assign(2, "pro");
    await f.plans.assign(2, "pro");
    expect(f.grants()).toBe(4);
    const active = f.subs.filter((s) => s.status === "active");
    expect(active).toHaveLength(2);
    expect(active.every((s) => [3, 4].includes(s.plan_id))).toBe(true);
    expect(active.some((s) => s.amount_used === 123)).toBe(failure !== "first grant");
  });
}
