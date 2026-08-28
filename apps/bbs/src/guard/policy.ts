/**
 * THE RATE POLICY AS PURE FUNCTIONS. Port of rm-wenku guard/mod.rs
 * decide/allows/report_* with every I/O removed: state in, state out.
 * index.ts adds the serialisation, persistence and sleeping; store.ts owns
 * the wire keys. Because this file is pure, Frame 2 done-predicate 2
 * (spacing, 20/min, 2 000/day at UTC midnight, reserve 200, ladder, Throttled
 * past 30 s) is tested against numbers, not timers.
 *
 * Invariants:
 *  - `decide` never mutates; `proceed` is the only function that increments counters.
 *  - Windows roll lazily: `roll(state, now)` is applied before any decision, so a
 *    state loaded from disk after a day away is correct without a scheduler.
 *  - Day window is anchored at UTC midnight (not "24 h since first request").
 *  - Refusal order (rm-wenku allows()): circuitOpen → dayExhausted → [interactive: ok]
 *    → degraded (consecutiveFailures > 0) → reserveHeld (dayCount + reserve >= maxPerDay).
 */
export interface GuardConfig {
  readonly minIntervalMs: number;
  readonly jitterMs: number;
  readonly maxPerMinute: number;
  readonly maxPerDay: number;
  readonly cooldownMaxMs: number;
  readonly maxWaitMs: number;
  readonly backgroundReserve: number;
}

/** rm-wenku GuardConfig::default(). reserve = max(day/10, 50) = 200. */
export const DEFAULT_GUARD: GuardConfig = {
  minIntervalMs: 2_000,
  jitterMs: 1_000,
  maxPerMinute: 20,
  maxPerDay: 2_000,
  cooldownMaxMs: 86_400_000,
  maxWaitMs: 30_000,
  backgroundReserve: 200,
};

/** Guard::permissive — every limit off, breaker off. A config, not a code path; nothing in src/ references it. */
export const PERMISSIVE_GUARD: GuardConfig = {
  minIntervalMs: 0,
  jitterMs: 0,
  maxPerMinute: Number.MAX_SAFE_INTEGER,
  maxPerDay: Number.MAX_SAFE_INTEGER,
  cooldownMaxMs: 0,
  maxWaitMs: Number.MAX_SAFE_INTEGER,
  backgroundReserve: 0,
};

/** Seconds, indexed by consecutiveFailures-1; the last repeats. effective = min(max(retryAfter, step), cooldownMax). */
export const COOLDOWN_STEPS_S = [60, 300, 1_800, 7_200, 86_400] as const;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** In-memory shape (camelCase). The persisted JSON uses rm-wenku's snake_case keys — store.ts is the only codec. */
export interface GuardState {
  readonly consecutiveFailures: number;
  readonly openUntilMs: number | null;
  readonly minuteWindowStartMs: number;
  readonly minuteCount: number;
  readonly dayWindowStartMs: number;
  readonly dayCount: number;
  readonly lastRequestAtMs: number | null;
  readonly lastFailureAtMs: number | null;
  readonly lastFailureReason: string | null;
  readonly totalRequests: number;
}

export function initialState(nowMs: number): GuardState {
  return {
    consecutiveFailures: 0,
    openUntilMs: null,
    minuteWindowStartMs: nowMs,
    minuteCount: 0,
    dayWindowStartMs: utcDayStart(nowMs),
    dayCount: 0,
    lastRequestAtMs: null,
    lastFailureAtMs: null,
    lastFailureReason: null,
    totalRequests: 0,
  };
}

export type FailureKind = "rateLimited" | "forbidden" | "serverError" | "network" | "blocked";
export type Priority = "interactive" | "background";

export type Decision =
  | { readonly kind: "proceed" }
  | {
      readonly kind: "wait";
      readonly untilMs: number;
      readonly reason: "circuitOpen" | "dayExhausted" | "minuteExhausted" | "spacing";
    };

export type Refusal =
  | {
      readonly kind: "circuitOpen";
      readonly untilMs: number;
      readonly failures: number;
      readonly reason: string | null;
    }
  | { readonly kind: "dayExhausted"; readonly resetsAtMs: number }
  | { readonly kind: "degraded"; readonly failures: number }
  | { readonly kind: "reserveHeld"; readonly resetsAtMs: number };

export function utcDayStart(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

export function nextUtcMidnight(nowMs: number): number {
  return utcDayStart(nowMs) + DAY_MS;
}

/** Rolls the minute (60 s since start) and day (UTC-midnight) windows forward. Idempotent. */
export function roll(state: GuardState, nowMs: number): GuardState {
  let s = state;
  if (nowMs - s.minuteWindowStartMs >= MINUTE_MS) {
    s = { ...s, minuteWindowStartMs: nowMs, minuteCount: 0 };
  }
  if (utcDayStart(nowMs) > s.dayWindowStartMs) {
    s = { ...s, dayWindowStartMs: utcDayStart(nowMs), dayCount: 0 };
  }
  return s;
}

/** `jitterMs` is caller-supplied (clock.random() * cfg.jitterMs) so this stays pure. */
export function decide(
  state: GuardState,
  cfg: GuardConfig,
  nowMs: number,
  jitterMs: number,
): Decision {
  const s = roll(state, nowMs);
  if (s.openUntilMs !== null && s.openUntilMs > nowMs) {
    return { kind: "wait", untilMs: s.openUntilMs, reason: "circuitOpen" };
  }
  if (s.dayCount >= cfg.maxPerDay) {
    return { kind: "wait", untilMs: nextUtcMidnight(nowMs), reason: "dayExhausted" };
  }
  if (s.minuteCount >= cfg.maxPerMinute) {
    return { kind: "wait", untilMs: s.minuteWindowStartMs + MINUTE_MS, reason: "minuteExhausted" };
  }
  if (s.lastRequestAtMs !== null) {
    const earliest = s.lastRequestAtMs + cfg.minIntervalMs + jitterMs;
    if (earliest > nowMs) return { kind: "wait", untilMs: earliest, reason: "spacing" };
  }
  return { kind: "proceed" };
}

/** The only counter mutation: minute/day/total ++, lastRequestAt = now. Applied (to a rolled state) after a `proceed`. */
export function proceed(state: GuardState, nowMs: number): GuardState {
  const s = roll(state, nowMs);
  return {
    ...s,
    minuteCount: s.minuteCount + 1,
    dayCount: s.dayCount + 1,
    totalRequests: s.totalRequests + 1,
    lastRequestAtMs: nowMs,
  };
}

export function recordSuccess(state: GuardState): GuardState {
  return { ...state, consecutiveFailures: 0, openUntilMs: null };
}

export function recordFailure(
  state: GuardState,
  cfg: GuardConfig,
  kind: FailureKind,
  retryAfterSec: number | null,
  message: string,
  nowMs: number,
): GuardState {
  const n = state.consecutiveFailures + 1;
  const step = COOLDOWN_STEPS_S[Math.min(n, COOLDOWN_STEPS_S.length) - 1]! * 1000;
  const cooldown = Math.min(Math.max((retryAfterSec ?? 0) * 1000, step), cfg.cooldownMaxMs);
  return {
    ...state,
    consecutiveFailures: n,
    openUntilMs: nowMs + cooldown,
    lastFailureAtMs: nowMs,
    lastFailureReason: `${kind}: ${message}`.slice(0, 200),
  };
}

/** Pre-flight for the fetch loop (no wait, no count). Order: circuitOpen → dayExhausted → (interactive: null) → degraded → reserveHeld. */
export function refusal(
  state: GuardState,
  cfg: GuardConfig,
  priority: Priority,
  nowMs: number,
): Refusal | null {
  const s = roll(state, nowMs);
  if (s.openUntilMs !== null && s.openUntilMs > nowMs) {
    return {
      kind: "circuitOpen",
      untilMs: s.openUntilMs,
      failures: s.consecutiveFailures,
      reason: s.lastFailureReason,
    };
  }
  if (s.dayCount >= cfg.maxPerDay) {
    return { kind: "dayExhausted", resetsAtMs: nextUtcMidnight(nowMs) };
  }
  if (priority === "interactive") return null;
  if (s.consecutiveFailures > 0) return { kind: "degraded", failures: s.consecutiveFailures };
  if (s.dayCount + cfg.backgroundReserve >= cfg.maxPerDay) {
    return { kind: "reserveHeld", resetsAtMs: nextUtcMidnight(nowMs) };
  }
  return null;
}
