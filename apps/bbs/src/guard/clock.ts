/**
 * Time and randomness as one injected value. The guard, the worker's pacing
 * and every timestamp written to the database read `now()` from here; tests
 * pass a FakeClock whose `sleep` advances virtual time instead of waiting.
 *
 * `sleep` resolves early ("aborted") when `signal` aborts (the worker's wake /
 * shutdown); the guard's own waits never pass a signal — a spacing wait is not
 * interruptible.
 */
export interface Clock {
  now(): number; // ms epoch
  sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "aborted">;
  /** Uniform [0, 1). The guard's jitter and the discovery loop's delay are the only consumers. */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("aborted");
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve("aborted");
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve("elapsed");
        },
        Math.max(0, ms),
      );
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  random: Math.random,
};

/**
 * Virtual time. By default `sleep` advances `now` by `ms` (after a microtask)
 * so a loop under test never waits; with `autoAdvance: false` a sleep stays
 * pending until `advance(ms)` reaches it — for tests that need to interleave a
 * wake or an abort with a sleep in progress.
 */
export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
  /** Every sleep the code asked for, in order — tests assert pacing (10 s, 60 s, ladder steps) from this. */
  readonly sleeps: readonly number[];
}

export function fakeClock(
  startMs: number,
  options: { random?: () => number; autoAdvance?: boolean } = {},
): FakeClock {
  let now = startMs;
  const sleeps: number[] = [];
  const pending: { due: number; resolve: (r: "elapsed" | "aborted") => void }[] = [];
  const autoAdvance = options.autoAdvance ?? true;
  const random = options.random ?? (() => 0);

  const fire = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      if (p.due <= now) {
        pending.splice(i, 1);
        p.resolve("elapsed");
      }
    }
  };

  return {
    now: () => now,
    random,
    sleeps,
    set: (ms) => {
      now = ms;
      fire();
    },
    advance: (ms) => {
      now += ms;
      fire();
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        sleeps.push(ms);
        if (signal?.aborted) {
          resolve("aborted");
          return;
        }
        if (autoAdvance) {
          queueMicrotask(() => {
            now += Math.max(0, ms);
            resolve("elapsed");
          });
          return;
        }
        const entry = { due: now + Math.max(0, ms), resolve };
        pending.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const i = pending.indexOf(entry);
            if (i >= 0) {
              pending.splice(i, 1);
              resolve("aborted");
            }
          },
          { once: true },
        );
      }),
  };
}
