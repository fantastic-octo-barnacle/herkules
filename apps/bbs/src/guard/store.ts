/**
 * Where GuardState sleeps between requests: one jsonb blob per source in
 * `source_guard_state`, upserted on every transition (rm-wenku did the same;
 * ~1 ms, and a restart resumes mid-window instead of resetting the day count).
 *
 * THIS FILE OWNS THE WIRE KEYS. rm-wenku wrote snake_case with two renamed
 * fields (`minute_bucket_start_ms`, `day_bucket_start_ms`); the imported blob
 * must keep counting, so the codec here maps them to the camelCase GuardState
 * and back. policy.ts never sees a wire key.
 *
 * Boundary: a blob we did not write. Parsed with zod; a corrupt or empty blob
 * degrades to `null` (→ initialState) with one log line, never a crash loop.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { BbsDb } from "../db/index.ts";
import { sourceGuardState } from "../db/schema.ts";
import type { GuardState } from "./policy.ts";

export interface GuardStore {
  load(sourceId: string): Promise<GuardState | null>;
  /** INSERT … ON CONFLICT (source_id) DO UPDATE SET state_json, updated_at. */
  save(sourceId: string, state: GuardState, nowMs: number): Promise<void>;
}

const wire = z.object({
  consecutive_failures: z.number().int().nonnegative(),
  open_until_ms: z.number().nullable(),
  minute_bucket_start_ms: z.number(),
  minute_count: z.number().int().nonnegative(),
  day_bucket_start_ms: z.number(),
  day_count: z.number().int().nonnegative(),
  last_request_at_ms: z.number().nullable(),
  last_failure_at_ms: z.number().nullable(),
  last_failure_reason: z.string().nullable(),
  total_requests: z.number().int().nonnegative(),
});

/** Wire shape, exactly rm-wenku's `GuardState` serde output. Exported for the round-trip test only. */
export type GuardStateJson = z.infer<typeof wire>;

export function toJson(state: GuardState): GuardStateJson {
  return {
    consecutive_failures: state.consecutiveFailures,
    open_until_ms: state.openUntilMs,
    minute_bucket_start_ms: state.minuteWindowStartMs,
    minute_count: state.minuteCount,
    day_bucket_start_ms: state.dayWindowStartMs,
    day_count: state.dayCount,
    last_request_at_ms: state.lastRequestAtMs,
    last_failure_at_ms: state.lastFailureAtMs,
    last_failure_reason: state.lastFailureReason,
    total_requests: state.totalRequests,
  };
}

/** zod-validated; returns null for anything that does not parse (logged once by the caller). */
export function fromJson(blob: unknown): GuardState | null {
  const parsed = wire.safeParse(blob);
  if (!parsed.success) return null;
  const w = parsed.data;
  return {
    consecutiveFailures: w.consecutive_failures,
    openUntilMs: w.open_until_ms,
    minuteWindowStartMs: w.minute_bucket_start_ms,
    minuteCount: w.minute_count,
    dayWindowStartMs: w.day_bucket_start_ms,
    dayCount: w.day_count,
    lastRequestAtMs: w.last_request_at_ms,
    lastFailureAtMs: w.last_failure_at_ms,
    lastFailureReason: w.last_failure_reason,
    totalRequests: w.total_requests,
  };
}

export function pgGuardStore(db: BbsDb, log: (line: string) => void): GuardStore {
  return {
    async load(sourceId) {
      const rows = await db
        .select({ state: sourceGuardState.stateJson })
        .from(sourceGuardState)
        .where(eq(sourceGuardState.sourceId, sourceId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const state = fromJson(row.state);
      if (!state) {
        log(`guard: source_guard_state for ${sourceId} is not a GuardState; starting fresh`);
      }
      return state;
    },
    async save(sourceId, state, nowMs) {
      const updatedAt = new Date(nowMs);
      const stateJson = toJson(state);
      await db
        .insert(sourceGuardState)
        .values({ sourceId, stateJson, updatedAt })
        .onConflictDoUpdate({
          target: sourceGuardState.sourceId,
          set: { stateJson, updatedAt },
        });
    },
  };
}

/** Tests that exercise policy without a database; `saves` counts persists (over-count-not-under test). */
export function memoryGuardStore(
  initial?: GuardState,
): GuardStore & { readonly saves: number; readonly state: GuardState | null } {
  const store = {
    saves: 0,
    state: initial ?? null,
    async load() {
      return store.state;
    },
    async save(_sourceId: string, next: GuardState) {
      store.state = next;
      store.saves += 1;
    },
  };
  return store;
}
