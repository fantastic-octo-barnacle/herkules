/**
 * The worker end to end on PGlite with a fake forum and a fake clock, then the
 * API's stale-GET hook, the import→crawl coexistence, rederive and the CLIs.
 */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createCorpus } from "../src/crawl/corpus.ts";
import type { ArticleRowId } from "../src/crawl/corpus.ts";
import { formatRederive, runMigrateCli, runRederiveCli, runWorkCli } from "../src/crawl/cli.ts";
import { createCrawler } from "../src/crawl/index.ts";
import { rederive } from "../src/crawl/rederive.ts";
import type { WorkerDeps } from "../src/crawl/worker.ts";
import {
  FETCH_ERROR_PAUSE_MS,
  FETCH_INTERVAL_MS,
  ONCE,
  RESTART_BACKOFF_MIN_MS,
  createWake,
  fetchLoop,
  runCycle,
  runWork,
  supervise,
} from "../src/crawl/worker.ts";
import { rowsOf } from "../src/db/index.ts";
import { articles, corpusVersions, pollRuns, sources } from "../src/db/schema.ts";
import { fakeClock } from "../src/guard/clock.ts";
import {
  DEFAULT_GUARD,
  PERMISSIVE_GUARD,
  ThrottledError,
  createGuard,
} from "../src/guard/index.ts";
import { memoryGuardStore } from "../src/guard/store.ts";
import { createRobomasterSource } from "../src/source/robomaster.ts";
import { T0, digestTables, fakeForum, freshDb, post } from "./crawl-helpers.ts";
import { createTestBbs } from "./helpers.ts";

const LOG: string[] = [];
const log = (l: string) => LOG.push(l);

/** 3 posts on page 1, 2 on page 2 (total 5 → page 2 is last); one pinned; one that 404s. */
function forumFixture() {
  return fakeForum({
    pages: [
      [
        post(101, { createAt: "2026-08-27 10:00:00" }),
        post(102, { top: true, createAt: "2026-08-26 10:00:00" }),
        post(103, { createAt: "2026-08-25 10:00:00" }),
      ],
      [
        post(104, { createAt: "2026-08-24 10:00:00" }),
        post(105, { createAt: "2026-08-23 10:00:00" }),
      ],
    ],
  });
}

describe("once() on an empty database", () => {
  it("discovers, backfills, fetches, skips pinned, and is idempotent", async () => {
    const db = await freshDb();
    try {
      const forum = forumFixture();
      forum.posts.delete("103"); // → post_missing → notFound → failed
      const clock = fakeClock(T0);
      const crawler = createCrawler({
        db,
        fetch: forum.fetch,
        clock,
        guard: PERMISSIVE_GUARD,
        log,
      });
      const first = await crawler.once();
      expect(first).toEqual({
        listed: 5,
        discovered: 5,
        fetched: 3,
        skipped: 1,
        failed: 1,
        refreshed: 0,
        error: null,
      });
      expect(
        forum.requests.map((r) => r.path.replace("/developers-server/rest/posts/", "")),
      ).toEqual(["list", "list", "info/101", "info/103", "info/104", "info/105"]); // 102 pinned: no request
      const [src] = await db.select().from(sources);
      expect(src).toMatchObject({ backfillNextPage: 3, initializedAt: new Date(T0) });
      expect(src!.backfillCompletedAt).not.toBeNull();
      const rows = await db
        .select({
          id: articles.sourceArticleId,
          status: articles.status,
          skip: articles.skipReason,
          err: articles.lastError,
        })
        .from(articles);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        "101": "fetched",
        "102": "skipped",
        "103": "failed",
        "104": "fetched",
        "105": "fetched",
      });
      expect(rows.find((r) => r.id === "103")?.err).toBe("not found");
      expect(rowsOf(await db.execute(sql`select count(*) as n from article_search`))[0]?.n).toBe(3);
      expect((await db.select().from(pollRuns))[0]).toMatchObject({
        status: "succeeded",
        trigger: "manual",
        listed: 5,
      });

      const before = await digestTables(db, [
        "articles",
        "article_tags",
        "article_links",
        "article_images",
        "article_search",
        "sources",
      ]);
      const again = await crawler.once();
      expect(again).toMatchObject({ discovered: 0, fetched: 0, skipped: 0, failed: 0 });
      expect(
        await digestTables(db, [
          "articles",
          "article_tags",
          "article_links",
          "article_images",
          "article_search",
          "sources",
        ]),
      ).toEqual(before);
      expect(forum.requests).toHaveLength(7); // one more listing
      expect(await db.select().from(pollRuns)).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it("too-short bodies are skipped; a throttle ends the fetch phase without touching rows", async () => {
    const db = await freshDb();
    try {
      const forum = fakeForum({
        pages: [[post(1, { htmlContent: "<p>太短</p>" }), post(2), post(3)]],
      });
      const clock = fakeClock(T0);
      const crawler = createCrawler({
        db,
        fetch: forum.fetch,
        clock,
        guard: PERMISSIVE_GUARD,
        log,
      });
      const o = await crawler.once();
      expect(o).toMatchObject({ skipped: 1, fetched: 2 });
      const short = (await db.select().from(articles).where(eq(articles.sourceArticleId, "1")))[0];
      expect(short).toMatchObject({ status: "skipped", skipReason: "too_short" });

      // now a guard that throttles the second info request
      const db2 = await freshDb();
      try {
        const forum2 = fakeForum({ pages: [[post(1), post(2), post(3)]] });
        const guard = await createGuard({
          sourceId: "robomaster",
          store: memoryGuardStore(),
          clock,
          config: PERMISSIVE_GUARD,
        });
        let n = 0;
        const throttling = {
          ...guard,
          acquire: (p: "interactive" | "background") => {
            n += 1;
            if (n === 4) throw new ThrottledError(T0 + 120_000, "circuitOpen"); // list, backfill page, first info, THEN throttle
            return guard.acquire(p);
          },
        };
        const corpus = createCorpus(db2, "robomaster");
        await corpus.ensureSource(
          { kind: "robomaster", name: "RM", siteUrl: "https://x/" },
          new Date(T0),
        );
        const deps: WorkerDeps = {
          corpus,
          guard: throttling,
          clock,
          log,
          source: createRobomasterSource({ fetch: forum2.fetch, guard: throttling }),
        };
        const o2 = await runCycle(deps, "manual", ONCE);
        expect(o2).toMatchObject({ fetched: 1, failed: 0, error: null });
        const statuses = (await db2.select({ s: articles.status }).from(articles))
          .map((r) => r.s)
          .sort();
        expect(statuses).toEqual(["fetched", "pending", "pending"]);
        expect((await db2.select().from(pollRuns))[0]?.status).toBe("succeeded");
      } finally {
        await db2.close();
      }
    } finally {
      await db.close();
    }
  });
});

describe("fetch loop", () => {
  async function loopDeps(forum: ReturnType<typeof fakeForum>, guardConfig = PERMISSIVE_GUARD) {
    const db = await freshDb();
    const clock = fakeClock(T0);
    const guard = await createGuard({
      sourceId: "robomaster",
      store: memoryGuardStore(),
      clock,
      config: guardConfig,
    });
    const corpus = createCorpus(db, "robomaster");
    await corpus.ensureSource(
      { kind: "robomaster", name: "RM", siteUrl: "https://x/" },
      new Date(T0),
    );
    const source = createRobomasterSource({ fetch: forum.fetch, guard });
    return {
      db,
      clock,
      guard,
      corpus,
      deps: { corpus, guard, clock, log, source } satisfies WorkerDeps,
    };
  }

  it("paces stored/failed/backfill by 10 s, skips immediately, idles on the wake", async () => {
    const forum = fakeForum({ pages: [[post(1), post(2, { top: true })]], total: 2 });
    const { db, clock, corpus, deps } = await loopDeps(forum);
    try {
      await corpus.discover((await deps.source.listPage(1, 20, "background")).items, new Date(T0));
      await corpus.advanceBackfill(2, new Date(T0), new Date(T0)); // no backfill rung
      const ac = new AbortController();
      const wake = createWake(clock);
      let idles = 0;
      const originalWait = wake.wait.bind(wake);
      wake.wait = async (ms, s) => {
        idles += 1;
        if (idles === 2) ac.abort();
        return originalWait(ms, s);
      };
      await fetchLoop(deps, wake, ac.signal);
      expect(clock.sleeps).toEqual([FETCH_INTERVAL_MS, 60_000]); // stored → 10 s; pinned skip → none; idle; the second idle is aborted
      const statuses = (
        await db.select({ id: articles.sourceArticleId, s: articles.status }).from(articles)
      ).sort((a, b) => a.id.localeCompare(b.id));
      expect(statuses).toEqual([
        { id: "1", s: "fetched" },
        { id: "2", s: "skipped" },
      ]);
    } finally {
      await db.close();
    }
  });

  it("a background refusal pauses fetch/backfill work but not a refresh; a crash pauses 60 s", async () => {
    const forum = fakeForum({ pages: [[post(1)]], total: 1 });
    const { db, clock, guard, corpus, deps } = await loopDeps(forum, DEFAULT_GUARD);
    try {
      await corpus.discover((await deps.source.listPage(1, 20, "background")).items, new Date(T0));
      await corpus.advanceBackfill(2, new Date(T0), new Date(T0));
      // trip the breaker: one failure → degraded once the cooldown passes
      forum.inject({ status: 500 });
      await expect(deps.source.listPage(1, 20, "background")).rejects.toThrow("http 500");
      clock.advance(61_000);
      expect(guard.allows("background")).toEqual({ kind: "degraded", failures: 1 });
      const ac = new AbortController();
      const wake = createWake(clock);
      let waits = 0;
      const originalWait = wake.wait.bind(wake);
      wake.wait = async (ms, s) => {
        waits += 1;
        if (waits === 1) {
          expect(ms).toBe(900_000); // degraded has no until → PAUSE_RECHECK
          ac.abort();
        }
        return originalWait(ms, s);
      };
      await fetchLoop(deps, wake, ac.signal);
      expect((await db.select().from(articles))[0]?.status).toBe("pending"); // nothing fetched while paused

      // a refresh is interactive: runs even when degraded
      const id = (await db.select({ id: articles.id }).from(articles))[0]!.id as ArticleRowId;
      const stored = await runWork(deps, {
        kind: "fetch",
        article: { id, sourceArticleId: "1", title: "t", isPinned: false },
      });
      expect(stored).toEqual({ kind: "stored" });
      await db.update(articles).set({ refreshRequestedAt: new Date(T0) });
      const refreshed = await runWork(deps, {
        kind: "refresh",
        article: { id, sourceArticleId: "1", title: "t", isPinned: false },
      });
      expect(refreshed).toEqual({ kind: "stored" });

      // a crash inside storeDetail marks the row failed and rethrows; the loop pauses 60 s
      const crashing: WorkerDeps = {
        ...deps,
        corpus: {
          ...corpus,
          storeDetail: async () => {
            throw new Error("disk full");
          },
        },
      };
      await db.update(articles).set({ status: "pending" });
      await expect(
        runWork(crashing, {
          kind: "fetch",
          article: { id, sourceArticleId: "1", title: "t", isPinned: false },
        }),
      ).rejects.toThrow("disk full");
      expect((await db.select().from(articles))[0]).toMatchObject({
        status: "failed",
        lastError: "internal error: Error: disk full",
      });
      await db.update(articles).set({ status: "pending" });
      const sleepsBefore = clock.sleeps.length;
      const ac2 = new AbortController();
      const okGuard = await createGuard({
        sourceId: "robomaster",
        store: memoryGuardStore(),
        clock,
        config: PERMISSIVE_GUARD,
      });
      let n = 0;
      const crashOnce: WorkerDeps = {
        ...crashing,
        guard: okGuard,
        source: createRobomasterSource({ fetch: forum.fetch, guard: okGuard }),
        corpus: {
          ...corpus,
          storeDetail: async (...args) => {
            n += 1;
            if (n === 1) throw new Error("once");
            ac2.abort();
            return corpus.storeDetail(...args);
          },
        },
      };
      await fetchLoop(crashOnce, createWake(clock), ac2.signal);
      expect(clock.sleeps[sleepsBefore]).toBe(FETCH_ERROR_PAUSE_MS);
    } finally {
      await db.close();
    }
  });

  it("supervise backs off 30, 60, 120 s and stops on abort", async () => {
    const clock = fakeClock(T0);
    const ac = new AbortController();
    let runs = 0;
    const loop = async () => {
      runs += 1;
      if (runs === 4) {
        ac.abort();
        return;
      }
      throw new Error(`crash ${runs}`);
    };
    const corpus = createCorpus(await freshDb(), "robomaster");
    await supervise("t", { corpus, clock, log } as unknown as WorkerDeps, loop, ac.signal);
    expect(clock.sleeps).toEqual([RESTART_BACKOFF_MIN_MS, 60_000, 120_000]);
    expect(runs).toBe(4);
  });

  it("wake shortens an idle wait and remembers a wake with no waiter", async () => {
    const clock = fakeClock(T0, { autoAdvance: false });
    const wake = createWake(clock);
    wake.wake();
    expect(await wake.wait(1000)).toBe("woken");
    const pending = wake.wait(60_000);
    wake.wake();
    expect(await pending).toBe("woken");
    const timed = wake.wait(5_000);
    clock.advance(5_000);
    expect(await timed).toBe("timeout");
    const ac = new AbortController();
    const aborted = wake.wait(5_000, ac.signal);
    ac.abort();
    expect(await aborted).toBe("aborted");
  });
});

describe("service integration", () => {
  it("a stale REST GET queues a refresh once; MCP reads never do; the next once() serves it", async () => {
    const bbs = await createTestBbs({ importFixture: true });
    try {
      const { db } = bbs.service;
      const fetched = (
        await db
          .select({ id: articles.id })
          .from(articles)
          .where(eq(articles.status, "fetched"))
          .limit(1)
      )[0]!;
      await db
        .update(articles)
        .set({ fetchedAt: new Date(Date.now() - 25 * 3_600_000), refreshRequestedAt: null })
        .where(eq(articles.id, fetched.id));
      const res = await bbs.fetch(`/api/articles/${fetched.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(fetched.id);
      const row = (await db.select().from(articles).where(eq(articles.id, fetched.id)))[0]!;
      expect(row.refreshRequestedAt).not.toBeNull();
      const requestedAt = row.refreshRequestedAt!.getTime();
      await bbs.fetch(`/api/articles/${fetched.id}`);
      expect(
        (
          await db.select().from(articles).where(eq(articles.id, fetched.id))
        )[0]!.refreshRequestedAt!.getTime(),
      ).toBe(requestedAt);

      // the crawler refreshes it from a forum that knows the post, coexisting with the imported rows
      const forum = fakeForum({
        pages: [[post(900001, { createAt: "2026-08-27 10:00:00" })]],
        posts: [post(row.sourceArticleId, { title: row.title })],
      });
      // the fixture's source id is 'src-bbs'; the crawler owns 'robomaster' (rm-wenku's SOURCE_ID, what the real backup carries)
      await createCorpus(db, "robomaster").ensureSource(
        { kind: "robomaster", name: "RM", siteUrl: "https://x/" },
        new Date(),
      );
      await db.update(articles).set({ sourceId: "robomaster" });
      const before = await db.select({ n: sql<number>`count(*)` }).from(articles);
      const crawler = createCrawler({
        db,
        fetch: forum.fetch,
        clock: fakeClock(Date.now()),
        guard: PERMISSIVE_GUARD,
        log,
      });
      const o = await crawler.once();
      expect(o).toMatchObject({ discovered: 1, refreshed: 1, error: null });
      const after = (await db.select().from(articles).where(eq(articles.id, fetched.id)))[0]!;
      expect(after.refreshRequestedAt).toBeNull();
      expect(after.status).toBe("fetched");
      expect(Number((await db.select({ n: sql<number>`count(*)` }).from(articles))[0]!.n)).toBe(
        Number(before[0]!.n) + 1,
      );
      const list = (await (await bbs.fetch("/api/articles")).json()) as { items: { id: string }[] };
      expect(list.items.length).toBeGreaterThan(0);
      // the crawler's guard state sits beside the imported blob (keyed by the old source id)
      expect(
        rowsOf(await db.execute(sql`select source_id from source_guard_state order by 1`)).map(
          (r) => r.source_id,
        ),
      ).toEqual(["robomaster", "src-bbs"]);
    } finally {
      await bbs.close();
    }
  });

  it("rederive on the imported fixture is a no-op; version drift rederives; the API boot wrote the row", async () => {
    const bbs = await createTestBbs({ importFixture: true });
    try {
      const { db } = bbs.service;
      expect(await db.select().from(corpusVersions)).toHaveLength(1);
      const forced = await rederive(db, { force: true });
      expect(forced.skipped).toBe(false);
      // title parts in the synthetic fixture are hand-written, not parsed from the titles; the real corpus is golden-tested
      expect(forced.changed).toMatchObject({ contentHtml: 0, articleDocument: 0, kbDocument: 0 });
      expect(forced.articles).toBeGreaterThan(0);
      expect((await rederive(db)).skipped).toBe(true);
      await db.update(corpusVersions).set({ titleVersion: "stale" });
      await db.update(articles).set({ titleTopic: "wrong" }).where(eq(articles.status, "fetched"));
      const drift = await rederive(db);
      expect(drift.from?.title).toBe("stale");
      expect(drift.changed.titleParts).toBeGreaterThan(0);
      expect(drift.changed.contentHtml).toBe(0);
      expect((await db.select().from(corpusVersions))[0]?.titleVersion).toBe(drift.to.title);
      expect(formatRederive(drift)[0]).toContain("title parts");
    } finally {
      await bbs.close();
    }
  });
});

describe("cli", () => {
  const env = {
    PUBLIC_ORIGIN: "http://localhost:3000",
    APP_ORIGIN: "http://localhost:3003",
    DATABASE_URL: "pglite://memory",
    BBS_CLIENT_SECRET: "bbs-secret-".padEnd(48, "x"),
    BBS_COOKIE_SECRET: "c".repeat(32),
    NODE_ENV: "test",
  };
  const capture = () => {
    const out: string[] = [];
    return {
      out,
      deps: { env, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(`! ${l}`) },
    };
  };

  it("migrate exits 0 and is repeatable; rederive/work refuse an unmigrated database", async () => {
    const { out, deps } = capture();
    expect(await runMigrateCli([], deps)).toBe(0);
    expect(out.some((l) => l.startsWith("rederive:"))).toBe(true);
    expect(await runMigrateCli(["extra"], deps)).toBe(2);
    // pglite://memory is fresh per connection, so a second process sees an unmigrated database:
    const r = capture();
    expect(await runRederiveCli([], r.deps)).toBe(1);
    expect(r.out.at(-1)).toContain("not migrated");
    const w = capture();
    expect(await runWorkCli(["--once"], { ...w.deps, fetch: fakeForum().fetch })).toBe(1);
    expect(await runWorkCli(["--bogus"], { ...w.deps, fetch: fakeForum().fetch })).toBe(2);
  });
});
