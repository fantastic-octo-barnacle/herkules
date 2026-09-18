import type { Config } from "./config.ts";
import { NewAPI } from "./new-api.ts";
import { TtlCache } from "./ttl-cache.ts";

/** Reconciliation runs every 30s (main.ts); the gateway closes when none succeeded for 60s. */
const FRESHNESS = 60_000;
/**
 * Revocation bound: a Herkules ban or removal is honoured at most VERDICT_TTL (20s) after the
 * last live read that admitted the account. Each reconciliation (~30s) also replaces every
 * cached verdict and binding, so a New API binding change applies at the next pass, and a
 * failing reconciliation closes the gateway after FRESHNESS (60s). Denials are never cached:
 * a newly enabled member is admitted on the next request. The post-queue recheck therefore
 * goes live exactly when the admitting read is older than VERDICT_TTL.
 */
export const VERDICT_TTL = 20_000;
const BINDING_TTL = 10 * 60_000;
const BINDING_CONCURRENCY = 5;
/** services/auth accepts at most 100 ids per /internal/ai-membership request. */
const STATUS_BATCH = 100;

export class Membership {
  private checkedAt = 0;
  private readonly config: Config;
  private readonly admin: NewAPI;
  private readonly bindings = new TtlCache<number, string>(BINDING_TTL);
  private readonly verdicts = new TtlCache<string, true>(VERDICT_TTL);
  private readonly pending = new Map<number, Promise<boolean>>();
  constructor(config: Config, admin: NewAPI) {
    this.config = config;
    this.admin = admin;
  }
  get ready() {
    return Date.now() - this.checkedAt < FRESHNESS;
  }
  async check(userId: number): Promise<boolean> {
    if (!this.ready) return false;
    const sub = this.bindings.get(userId);
    if (sub && this.verdicts.get(sub)) return true;
    // Collapse a dashboard's concurrent cold requests into one upstream check.
    let work = this.pending.get(userId);
    if (!work) {
      work = this.live(userId).finally(() => this.pending.delete(userId));
      this.pending.set(userId, work);
    }
    return work;
  }
  private async live(userId: number) {
    const at = Date.now();
    const sub = await this.binding(userId);
    if (sub && (await this.status([sub])).get(sub) === true) {
      this.bindings.set(userId, sub, at);
      this.verdicts.set(sub, true, at);
      return true;
    }
    this.bindings.delete(userId);
    return false;
  }
  private async binding(userId: number) {
    return (await this.admin.bindings(userId)).find((b) => b.provider_slug === "herkules")
      ?.provider_user_id;
  }
  private async status(ids: string[]) {
    const response = await fetch(`${this.config.AUTH_INTERNAL_URL}/internal/ai-membership`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.syncSecret}`,
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Herkules membership check failed");
    const data = (await response.json()) as { users: { id: string; enabled: boolean }[] };
    if (!Array.isArray(data.users)) throw new Error("Invalid membership response");
    return new Map(data.users.map((u) => [u.id, u.enabled]));
  }
  async reconcile() {
    const at = Date.now();
    const accounts = (await this.admin.users()).filter(
      (user) => user.role !== 100 && user.status === 1, // local break-glass root is private-only
    );
    const subs = new Map<number, string | undefined>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(BINDING_CONCURRENCY, accounts.length) }, async () => {
        while (next < accounts.length) {
          const user = accounts[next++];
          subs.set(user.id, await this.binding(user.id));
        }
      }),
    );
    const ids = [...new Set([...subs.values()].filter((sub) => sub !== undefined))];
    const enabled = new Map<string, boolean>();
    // Probe even with an empty account list, so an unavailable issuer cannot look healthy.
    for (let i = 0; i === 0 || i < ids.length; i += STATUS_BATCH)
      for (const [id, value] of await this.status(ids.slice(i, i + STATUS_BATCH)))
        enabled.set(id, value);
    // Swap caches synchronously so concurrent checks never observe a half-built state.
    this.bindings.clear();
    this.verdicts.clear();
    const revoked: number[] = [];
    for (const user of accounts) {
      const sub = subs.get(user.id);
      if (sub && enabled.get(sub) === true) {
        this.bindings.set(user.id, sub, at);
        this.verdicts.set(sub, true, at);
      } else revoked.push(user.id);
    }
    for (const id of revoked)
      await this.admin.call("/api/user/manage", "POST", { id, action: "disable" });
    this.checkedAt = Date.now();
  }
}
