import type { Config } from "./config.ts";
import { NewAPI } from "./new-api.ts";
export class Membership {
  private checkedAt = 0;
  private readonly subjects = new Map<number, string>();
  private readonly config: Config;
  private readonly admin: NewAPI;
  constructor(config: Config, admin: NewAPI) {
    this.config = config;
    this.admin = admin;
  }
  get ready() {
    return Date.now() - this.checkedAt < 60_000;
  }
  async check(userId: number) {
    if (!this.ready) return false;
    let sub = this.subjects.get(userId);
    if (!sub) {
      sub = (await this.admin.bindings(userId)).find(
        (b) => b.provider_slug === "herkules",
      )?.provider_user_id;
      if (!sub) return false;
      this.subjects.set(userId, sub);
    }
    return (await this.status([sub])).get(sub) === true;
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
    // Probe even with an empty account list, so an unavailable issuer cannot look healthy.
    await this.status([]);
    for (const user of await this.admin.users()) {
      if (user.role === 100 || user.status !== 1) continue; // local break-glass root is private-only
      const sub = (await this.admin.bindings(user.id)).find(
        (b) => b.provider_slug === "herkules",
      )?.provider_user_id;
      if (sub) this.subjects.set(user.id, sub);
      if (!sub || !(await this.status([sub])).get(sub))
        await this.admin.call("/api/user/manage", "POST", { id: user.id, action: "disable" });
    }
    this.checkedAt = Date.now();
  }
}
