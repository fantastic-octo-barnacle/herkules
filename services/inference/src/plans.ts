import type { NewAPI } from "./new-api.ts";
import { AdmissionError } from "./queue.ts";

export const tiers = {
  lite: { name: "Lite", local: 1_000_000, cloud: 500_000 },
  pro: { name: "Pro", local: 5_000_000, cloud: 5_000_000 },
  max: { name: "Max", local: 10_000_000, cloud: 10_000_000 },
} as const;
export type Tier = keyof typeof tiers;
type Plan = { id: number; title: string; herkules_pool: string };
type Subscription = {
  id: number;
  plan_id: number;
  status: string;
  end_time: number;
  amount_total: number;
  amount_used: number;
  next_reset_time: number;
};

/** New API owns reservations and resets. Never reset the user's permanent wallet. */
export class Plans {
  private plans: Plan[] = [];
  private locks = new Map<number, Promise<unknown>>();
  private readonly admin: NewAPI;
  constructor(admin: NewAPI) {
    this.admin = admin;
  }
  async bootstrap() {
    const existing = await this.admin.call<{ plan: Plan }[]>("/api/subscription/admin/plans");
    this.plans = existing.map((p) => p.plan);
    for (const tier of Object.values(tiers)) {
      for (const pool of ["local", "cloud"] as const) {
        const title = `Herkules ${tier.name} ${pool}`;
        const old = this.plans.find((p) => p.title === title);
        if (old) {
          if (old.herkules_pool !== pool) throw new Error("Subscription pool mismatch");
          continue;
        }
        const plan = await this.admin.call<Plan>("/api/subscription/admin/plans", "POST", {
          plan: {
            title,
            subtitle:
              pool === "local"
                ? "Weekly local compute credits"
                : "Weekly cloud budget; 1M credits = US$1",
            herkules_pool: pool,
            total_amount: tier[pool],
            quota_reset_period: "weekly",
            duration_unit: "year",
            duration_value: 100,
            price_amount: 0,
            currency: "USD",
            enabled: true,
            allow_balance_pay: false,
            allow_wallet_overflow: pool === "local",
          },
        });
        if (plan.herkules_pool !== pool)
          throw new Error("Backend does not support isolated subscription pools");
        this.plans.push(plan);
      }
    }
  }
  private async subscriptions(user: number) {
    return (
      await this.admin.call<{ subscription: Subscription }[]>(
        `/api/subscription/admin/users/${user}/subscriptions`,
      )
    ).map((s) => s.subscription);
  }
  private async locked<T>(user: number, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(user) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    this.locks.set(user, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(user) === work) this.locks.delete(user);
    }
  }
  private pair(tier: Tier) {
    return ["local", "cloud"].map((pool) => {
      const plan = this.plans.find((p) => p.title === `Herkules ${tiers[tier].name} ${pool}`);
      if (!plan) throw new Error("Plan catalog unavailable");
      return plan;
    });
  }
  async ensure(user: number) {
    return this.locked(user, async () => {
      const subs = await this.subscriptions(user);
      const active = subs.filter((s) => s.status === "active" && s.end_time > Date.now() / 1000);
      const tier = (Object.keys(tiers) as Tier[]).find((t) =>
        this.pair(t).some((p) => active.some((s) => s.plan_id === p.id)),
      );
      // Historical cancellation is not an invitation to re-grant Lite. Repair only a partial active pair.
      if (subs.length && !tier) return;
      for (const plan of this.pair(tier ?? "lite")) {
        if (subs.some((s) => s.plan_id === plan.id)) continue;
        await this.admin.call(`/api/subscription/admin/users/${user}/subscriptions`, "POST", {
          plan_id: plan.id,
        });
      }
    });
  }
  async assign(user: number, tier: Tier) {
    if (!Object.hasOwn(tiers, tier)) throw new AdmissionError("invalid_plan", 400);
    return this.locked(user, async () => {
      const subs = await this.subscriptions(user);
      const desired = this.pair(tier);
      const active = subs.filter((s) => s.status === "active" && s.end_time > Date.now() / 1000);
      // Repeated requests do not refresh an existing allowance.
      for (const sub of active) {
        if (desired.some((p) => p.id === sub.plan_id)) continue;
        if (!this.plans.some((p) => p.id === sub.plan_id && p.title.startsWith("Herkules ")))
          continue;
        await this.admin.call(
          `/api/subscription/admin/user_subscriptions/${sub.id}/invalidate`,
          "POST",
        );
      }
      for (const plan of desired) {
        if (active.some((s) => s.plan_id === plan.id)) continue;
        await this.admin.call(`/api/subscription/admin/users/${user}/subscriptions`, "POST", {
          plan_id: plan.id,
        });
      }
    });
  }
  async summary(user: number) {
    const subs = await this.subscriptions(user);
    const active = subs.filter((s) => s.status === "active" && s.end_time > Date.now() / 1000);
    return {
      tiers,
      cloudCreditsPerUSD: 1_000_000,
      resetTimezone: "Asia/Hong_Kong",
      pools: active.flatMap((s) => {
        const plan = this.plans.find((p) => p.id === s.plan_id);
        if (!plan?.title.startsWith("Herkules ")) return [];
        const resetDue = s.next_reset_time > 0 && s.next_reset_time <= Date.now() / 1000;
        return [
          {
            name: plan.title,
            pool: plan.herkules_pool,
            total: s.amount_total,
            remaining: Math.max(0, s.amount_total - (resetDue ? 0 : s.amount_used)),
            resetsAt: s.next_reset_time,
          },
        ];
      }),
    };
  }
}
