/** The rate policy against numbers (pure), then the stateful shell against a memory store and PGlite. */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { fakeClock } from "../src/guard/clock.ts";
import { ThrottledError, createGuard } from "../src/guard/index.ts";
import {
  COOLDOWN_STEPS_S,
  DEFAULT_GUARD,
  PERMISSIVE_GUARD,
  decide,
  initialState,
  nextUtcMidnight,
  proceed,
  recordFailure,
  recordSuccess,
  refusal,
} from "../src/guard/policy.ts";
import { fromJson, memoryGuardStore, pgGuardStore, toJson } from "../src/guard/store.ts";
import { SourceError, breakerKind } from "../src/source/index.ts";
import { T0, freshDb } from "./crawl-helpers.ts";

const cfg = DEFAULT_GUARD;

describe("guard policy", () => {
  it("spacing waits min_interval + jitter after a request", () => {
    const s = proceed(initialState(T0), T0);
    expect(decide(s, cfg, T0 + 1_000, 0)).toEqual({
      kind: "wait",
      untilMs: T0 + 2_000,
      reason: "spacing",
    });
    expect(decide(s, cfg, T0 + 1_000, 1_000)).toMatchObject({ untilMs: T0 + 3_000 });
    expect(decide(s, cfg, T0 + 3_000, 1_000)).toEqual({ kind: "proceed" });
  });

  it("minute window: the 21st request waits for the window end, then the count resets", () => {
    let s = initialState(T0);
    for (let i = 0; i < 20; i++) s = proceed(s, T0 + i * 2_500);
    expect(decide(s, cfg, T0 + 50_000, 0)).toEqual({
      kind: "wait",
      untilMs: T0 + 60_000,
      reason: "minuteExhausted",
    });
    expect(decide(s, cfg, T0 + 60_000, 0)).toEqual({ kind: "proceed" });
    expect(proceed(s, T0 + 60_000).minuteCount).toBe(1);
  });

  it("day window is anchored at UTC midnight", () => {
    const late = Date.UTC(2026, 7, 28, 23, 59, 59);
    let s = initialState(late);
    for (let i = 0; i < 2_000; i++) s = { ...proceed(s, late), minuteCount: 0 };
    expect(s.dayCount).toBe(2_000);
    expect(decide(s, cfg, late, 0)).toEqual({
      kind: "wait",
      untilMs: Date.UTC(2026, 7, 29),
      reason: "dayExhausted",
    });
    // One second later it is a new UTC day: the count resets at midnight, not 24 h after first use.
    expect(decide(s, cfg, Date.UTC(2026, 7, 29, 0, 0, 3), 0)).toEqual({ kind: "proceed" });
    expect(nextUtcMidnight(late)).toBe(Date.UTC(2026, 7, 29));
  });

  it("cooldown ladder: 60 s, 5 m, 30 m, 2 h, 24 h, 24 h; max(Retry-After, step); capped", () => {
    let s = initialState(T0);
    const expected = [60, 300, 1_800, 7_200, 86_400, 86_400];
    expected.forEach((sec, i) => {
      s = recordFailure(s, cfg, "serverError", null, "500", T0);
      expect(s.consecutiveFailures).toBe(i + 1);
      expect(s.openUntilMs).toBe(T0 + sec * 1000);
    });
    expect(COOLDOWN_STEPS_S).toHaveLength(5);
    const r = recordFailure(initialState(T0), cfg, "rateLimited", 900, "429", T0);
    expect(r.openUntilMs).toBe(T0 + 900_000);
    const capped = recordFailure(initialState(T0), cfg, "rateLimited", 200_000, "429", T0);
    expect(capped.openUntilMs).toBe(T0 + cfg.cooldownMaxMs);
  });

  it("success resets the breaker", () => {
    const failed = recordFailure(initialState(T0), cfg, "network", null, "reset", T0);
    const ok = recordSuccess(failed);
    expect(ok.consecutiveFailures).toBe(0);
    expect(ok.openUntilMs).toBeNull();
    expect(ok.lastFailureReason).toBe("network: reset");
  });

  it("refusal order: circuitOpen → dayExhausted → interactive OK → degraded → reserveHeld", () => {
    const open = recordFailure(initialState(T0), cfg, "forbidden", null, "403", T0);
    expect(refusal(open, cfg, "interactive", T0)).toMatchObject({
      kind: "circuitOpen",
      failures: 1,
    });
    // After the cooldown, a failure count > 0 pauses background but not interactive work.
    expect(refusal(open, cfg, "interactive", T0 + 61_000)).toBeNull();
    expect(refusal(open, cfg, "background", T0 + 61_000)).toEqual({
      kind: "degraded",
      failures: 1,
    });
    let s = initialState(T0);
    for (let i = 0; i < 1_800; i++) s = { ...proceed(s, T0), minuteCount: 0 };
    expect(refusal(s, cfg, "background", T0)).toEqual({
      kind: "reserveHeld",
      resetsAtMs: nextUtcMidnight(T0),
    });
    expect(refusal(s, cfg, "interactive", T0)).toBeNull();
    for (let i = 0; i < 200; i++) s = { ...proceed(s, T0), minuteCount: 0 };
    expect(refusal(s, cfg, "interactive", T0)).toMatchObject({ kind: "dayExhausted" });
  });

  it("breaker kinds: 429/403/5xx/network/blocked trip; 404, invalid, tooLarge, 3xx, other 4xx do not", () => {
    const k = (f: ConstructorParameters<typeof SourceError>[0]) => breakerKind(new SourceError(f));
    expect(k({ kind: "http", status: 429, retryAfterSec: 1 })).toBe("rateLimited");
    expect(k({ kind: "forbidden" })).toBe("forbidden");
    expect(k({ kind: "http", status: 503, retryAfterSec: null })).toBe("serverError");
    expect(k({ kind: "network", message: "x" })).toBe("network");
    expect(k({ kind: "blocked", message: "x" })).toBe("blocked");
    expect(k({ kind: "notFound" })).toBeNull();
    expect(k({ kind: "invalid", message: "x" })).toBeNull();
    expect(k({ kind: "tooLarge", bytes: 1 })).toBeNull();
    expect(k({ kind: "http", status: 302, retryAfterSec: null })).toBeNull();
    expect(k({ kind: "http", status: 400, retryAfterSec: null })).toBeNull();
  });

  it("permissive config never waits", () => {
    let s = initialState(T0);
    for (let i = 0; i < 100; i++) {
      expect(decide(s, PERMISSIVE_GUARD, T0, 0)).toEqual({ kind: "proceed" });
      s = proceed(s, T0);
    }
    expect(refusal(s, PERMISSIVE_GUARD, "background", T0)).toBeNull();
    const failed = recordFailure(s, PERMISSIVE_GUARD, "serverError", 900, "500", T0);
    expect(refusal(failed, PERMISSIVE_GUARD, "interactive", T0)).toBeNull();
  });
});

describe("guard shell", () => {
  it("throws ThrottledError past max_wait without counting or sleeping; sleeps under it", async () => {
    const clock = fakeClock(T0);
    const store = memoryGuardStore(
      recordFailure(initialState(T0), cfg, "serverError", null, "x", T0),
    );
    const guard = await createGuard({ sourceId: "robomaster", store, clock, config: cfg });
    // circuit open for 60 s > max_wait 30 s
    await expect(guard.acquire("background")).rejects.toBeInstanceOf(ThrottledError);
    expect(store.saves).toBe(0);
    expect(clock.sleeps).toEqual([]);
    clock.set(T0 + 31_000); // 29 s left: sleeps, then proceeds
    const lease = await guard.acquire("background");
    expect(clock.sleeps).toEqual([29_000]);
    expect(guard.snapshot().totalRequests).toBe(1);
    await lease.ok();
    expect(store.saves).toBe(2);
  });

  it("a lease settles exactly once; the save happens before the request", async () => {
    const clock = fakeClock(T0);
    const store = memoryGuardStore();
    const guard = await createGuard({
      sourceId: "robomaster",
      store,
      clock,
      config: PERMISSIVE_GUARD,
    });
    const lease = await guard.acquire("background");
    expect(store.saves).toBe(1); // over-count, never under-count
    await lease.ok();
    await expect(lease.failed("network", null, "x")).rejects.toThrow("settled twice");
  });

  it("acquires are serialised and spaced", async () => {
    const clock = fakeClock(T0);
    const guard = await createGuard({
      sourceId: "robomaster",
      store: memoryGuardStore(),
      clock,
      config: cfg,
    });
    const [a, b] = await Promise.all([guard.acquire("background"), guard.acquire("interactive")]);
    await a.ok();
    await b.ok();
    expect(clock.sleeps).toEqual([2_000]);
    expect(guard.snapshot().totalRequests).toBe(2);
  });

  it("state round-trips through source_guard_state with rm-wenku's wire keys", async () => {
    const db = await freshDb();
    try {
      const clock = fakeClock(T0);
      const log: string[] = [];
      const store = pgGuardStore(db, (l) => log.push(l));
      const guard = await createGuard({ sourceId: "robomaster", store, clock, config: cfg });
      const lease = await guard.acquire("background");
      await lease.failed("rateLimited", 900, "429");
      const raw = (await db.execute(sql`select state_json from source_guard_state`)) as unknown;
      const row = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows)[0] as {
        state_json: Record<string, unknown>;
      };
      expect(Object.keys(row.state_json).sort()).toEqual([
        "consecutive_failures",
        "day_bucket_start_ms",
        "day_count",
        "last_failure_at_ms",
        "last_failure_reason",
        "last_request_at_ms",
        "minute_bucket_start_ms",
        "minute_count",
        "open_until_ms",
        "total_requests",
      ]);
      const again = await createGuard({ sourceId: "robomaster", store, clock, config: cfg });
      expect(again.snapshot()).toEqual(guard.snapshot());
      expect(again.snapshot().openUntilMs).toBe(T0 + 900_000);
      expect(log).toEqual([]);
      expect(fromJson(toJson(guard.snapshot()))).toEqual(guard.snapshot());
    } finally {
      await db.close();
    }
  });

  it("a corrupt blob degrades to a fresh state with one log line", async () => {
    const db = await freshDb();
    try {
      for (const blob of ["{}", "null", '{"day_count":"lots"}']) {
        await db.execute(sql`delete from source_guard_state`);
        await db.execute(
          sql`insert into source_guard_state (source_id, state_json, updated_at) values ('robomaster', ${blob}::jsonb, now())`,
        );
        const log: string[] = [];
        const guard = await createGuard({
          sourceId: "robomaster",
          store: pgGuardStore(db, (l) => log.push(l)),
          clock: fakeClock(T0),
          config: cfg,
        });
        expect(guard.snapshot()).toEqual(initialState(T0));
        expect(log).toHaveLength(1);
      }
    } finally {
      await db.close();
    }
  });
});
