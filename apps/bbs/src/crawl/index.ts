/**
 * crawl/ public surface — three things:
 *
 *   createCrawler(deps).work(signal)   the bbs-worker process body (forever)
 *   createCrawler(deps).once()         one full cycle (tests, the manual check)
 *   noteArticleRead(db, id, now)       the API's stale-GET write (corpus.ts)
 *
 * Every seam is a constructor parameter: db, fetch, clock (time + random +
 * sleep), guard config. Nothing in this directory reads process.env.
 *
 * Trace "discovery found a post" → "row in article_search":
 *   worker.ts runCycle → corpus.ts discover (row, status pending, tags, dangling links)
 *   worker.ts fetchLoop/runWork → corpus.ts storeDetail (content_html, title parts, links+targets, images, article_search)
 * Two files (three with links.ts for target resolution).
 */
import { sql } from "drizzle-orm";

import type { BbsDb } from "../db/index.ts";
import { rowsOf } from "../db/index.ts";
import type { Clock } from "../guard/clock.ts";
import { systemClock } from "../guard/clock.ts";
import type { GuardConfig } from "../guard/index.ts";
import { DEFAULT_GUARD, createGuard } from "../guard/index.ts";
import { pgGuardStore } from "../guard/store.ts";
import { SOURCE_ID } from "../source/index.ts";
import {
  SITE_URL,
  SOURCE_KIND,
  SOURCE_NAME,
  createRobomasterSource,
} from "../source/robomaster.ts";
import type { RunOutcome } from "./corpus.ts";
import { createCorpus } from "./corpus.ts";
import type { WorkerDeps } from "./worker.ts";
import {
  DISCOVERY_ONLY,
  ONCE,
  createWake,
  discoveryLoop,
  fetchLoop,
  runCycle,
  supervise,
} from "./worker.ts";

export { noteArticleRead, REFRESH_STALE_AFTER_MS } from "./corpus.ts";
export type { RunOutcome } from "./corpus.ts";
export { DISCOVERY_ONLY, ONCE };

/** pg_try_advisory_lock key: one `bbs work` per database. */
export const WORKER_LOCK_KEY = 0x6262735f; // "bbs_"

export class WorkerLockHeldError extends Error {
  override readonly name = "WorkerLockHeldError";
}

export interface CrawlerDeps {
  readonly db: BbsDb;
  /**
   * A SECOND connection for the advisory lock (session-scoped: it must not come from the max-5 pool,
   * which hands the lock to whichever connection is returned). Built by cli.ts with a second createDb(url);
   * db/index.ts stays the only place a client is constructed. Omitted in tests (PGlite is one session, so
   * the lock is reentrant there and refusal is only testable on real Postgres).
   */
  readonly lockDb?: BbsDb;
  /** Outbound HTTP to the forum. Tests: a fake serving fixtures/robomaster/*.json. */
  readonly fetch: typeof globalThis.fetch;
  readonly clock?: Clock; // default systemClock
  readonly guard?: GuardConfig; // default DEFAULT_GUARD; tests pass PERMISSIVE_GUARD
  readonly log?: (line: string) => void; // default console.log with a "[bbs-worker]" prefix
}

export interface Crawler {
  /** Boot (lock, abandonRunning, ensureSource), then both loops under supervision until `signal` aborts. Throws WorkerLockHeldError. */
  work(signal: AbortSignal): Promise<void>;
  /** Boot (no lock), then exactly one full cycle (trigger 'manual', budget ONCE). Resolves with the poll_runs counters. */
  once(): Promise<RunOutcome>;
}

export function createCrawler(deps: CrawlerDeps): Crawler {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((line: string) => console.log("[bbs-worker]", line));
  const corpus = createCorpus(deps.db, SOURCE_ID);

  const boot = async (): Promise<WorkerDeps> => {
    const guard = await createGuard({
      sourceId: SOURCE_ID,
      store: pgGuardStore(deps.db, log),
      clock,
      config: deps.guard ?? DEFAULT_GUARD,
    });
    const source = createRobomasterSource({ fetch: deps.fetch, guard });
    const now = new Date(clock.now());
    const abandoned = await corpus.abandonRunning(now);
    if (abandoned > 0) log(`abandoned ${abandoned} interrupted poll run(s)`);
    await corpus.ensureSource({ kind: SOURCE_KIND, name: SOURCE_NAME, siteUrl: SITE_URL }, now);
    return { corpus, source, guard, clock, log };
  };

  return {
    async work(signal) {
      if (deps.lockDb) {
        const row = rowsOf(
          await deps.lockDb.execute(sql`select pg_try_advisory_lock(${WORKER_LOCK_KEY}) as locked`),
        )[0];
        if (!row?.locked) throw new WorkerLockHeldError("another bbs worker holds the lock");
      }
      const w = await boot();
      const wake = createWake(clock);
      log("worker started");
      await Promise.all([
        supervise("discovery", w, () => discoveryLoop(w, wake, signal), signal),
        supervise("fetch", w, () => fetchLoop(w, wake, signal), signal),
      ]);
      log("worker stopped");
    },
    async once() {
      const w = await boot();
      return runCycle(w, "manual", ONCE);
    },
  };
}
