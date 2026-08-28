/**
 * The Guard: policy.ts made stateful, serialised and persistent.
 *
 *   acquire(priority)                   wait (or throw ThrottledError) until a request may go, count it, PERSIST
 *   lease.ok() / lease.failed(...)      reset the breaker / step the ladder, persist
 *   allows(priority)                    pre-flight refusal for the fetch loop (no wait, no count)
 *
 * Persist BEFORE the request leaves: a crash between acquire and the response
 * leaves the counter incremented — over-count, never under-count.
 * Serialisation: one in-flight acquire at a time (a promise chain, the TS
 * Semaphore(1)); discovery and the fetch loop share this guard, so the forum
 * sees requests spaced even when both loops want one. Settles are chained too,
 * so a settle never interleaves an acquire's save.
 *
 * The guard knows nothing about the forum, HTTP, or articles. Its ONLY caller
 * of acquire is source/http.ts; its only caller of allows is crawl/worker.ts.
 * `priority` does not change decide(): rm-wenku's acquire ignored it too;
 * priority matters only in allows().
 */
import type { Clock } from "./clock.ts";
import type { FailureKind, GuardConfig, GuardState, Priority, Refusal } from "./policy.ts";
import {
  decide,
  initialState,
  proceed,
  recordFailure,
  recordSuccess,
  refusal,
  roll,
} from "./policy.ts";
import type { GuardStore } from "./store.ts";

export type { GuardConfig, GuardState, Priority, Refusal, FailureKind } from "./policy.ts";
export { DEFAULT_GUARD, PERMISSIVE_GUARD } from "./policy.ts";

/**
 * Thrown by `acquire` when the required wait exceeds config.maxWaitMs (30 s).
 * Nothing was counted, nothing was sent, and — the invariant crawl/ relies on —
 * nothing may be written to any article row in response to it.
 */
export class ThrottledError extends Error {
  override readonly name = "ThrottledError";
  readonly untilMs: number;
  readonly reason: string;
  constructor(untilMs: number, reason: string) {
    super(`throttled until ${new Date(untilMs).toISOString()} (${reason})`);
    this.untilMs = untilMs;
    this.reason = reason;
  }
}

/** A permit for exactly one request. Settle exactly once. */
export interface Lease {
  ok(): Promise<void>;
  failed(kind: FailureKind, retryAfterSec: number | null, message: string): Promise<void>;
}

export interface Guard {
  acquire(priority: Priority): Promise<Lease>;
  allows(priority: Priority): Refusal | null;
  /** For logs and tests. A copy, windows rolled to now. */
  snapshot(): GuardState;
}

export interface GuardDeps {
  readonly sourceId: string;
  readonly store: GuardStore;
  readonly clock: Clock;
  readonly config: GuardConfig;
}

export async function createGuard(deps: GuardDeps): Promise<Guard> {
  const { sourceId, store, clock, config } = deps;
  let state = (await store.load(sourceId)) ?? initialState(clock.now());
  let chain: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after every previously chained operation; a rejection does not poison the chain. */
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const persist = () => store.save(sourceId, state, clock.now());

  const lease = (): Lease => {
    let settled = false;
    const settle = (mutate: (now: number) => GuardState) =>
      serialized(async () => {
        if (settled) throw new Error("guard lease settled twice");
        settled = true;
        state = mutate(clock.now());
        await persist();
      });
    return {
      ok: () => settle(() => recordSuccess(state)),
      failed: (kind, retryAfterSec, message) =>
        settle((now) => recordFailure(state, config, kind, retryAfterSec, message, now)),
    };
  };

  return {
    acquire: () =>
      serialized(async () => {
        for (;;) {
          const now = clock.now();
          const d = decide(state, config, now, clock.random() * config.jitterMs);
          if (d.kind === "proceed") {
            state = proceed(state, now);
            await persist();
            return lease();
          }
          const wait = d.untilMs - now;
          if (wait > config.maxWaitMs) throw new ThrottledError(d.untilMs, d.reason);
          await clock.sleep(wait);
        }
      }),
    allows: (priority) => refusal(state, config, priority, clock.now()),
    snapshot: () => ({ ...roll(state, clock.now()) }),
  };
}
