import { expect, test } from "vite-plus/test";
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
  return { plans: new Plans(admin), catalog, subs, grants: () => grants };
}
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
