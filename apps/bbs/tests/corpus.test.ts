/** The write module on PGlite, no source: every operation's idempotence and every COALESCE rule. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createCorpus, noteArticleRead } from "../src/crawl/corpus.ts";
import type { ArticleRowId, Corpus } from "../src/crawl/corpus.ts";
import type { BbsDb } from "../src/db/index.ts";
import { rowsOf } from "../src/db/index.ts";
import {
  articleImages,
  articleLinks,
  articleSearch,
  articleTags,
  articles,
  pollRuns,
  sources,
} from "../src/db/schema.ts";
import { T0, articleUrl, detailOf, digestTables, freshDb, listed } from "./crawl-helpers.ts";

let db: BbsDb;
let corpus: Corpus;
const now = new Date(T0);
const later = (ms: number) => new Date(T0 + ms);

beforeAll(async () => {
  db = await freshDb();
  corpus = createCorpus(db, "robomaster");
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.execute(
    sql.raw(
      'TRUNCATE "articles", "article_tags", "article_links", "article_images", "article_search", "poll_runs", "sources" CASCADE',
    ),
  );
  await corpus.ensureSource({ kind: "robomaster", name: "RM", siteUrl: "https://x/" }, now);
});

async function rowOf(sourceArticleId: string) {
  return (
    await db.select().from(articles).where(eq(articles.sourceArticleId, sourceArticleId))
  )[0]!;
}
const idOf = async (sourceArticleId: string) => (await rowOf(sourceArticleId)).id as ArticleRowId;

describe("sources and poll runs", () => {
  it("ensureSource is idempotent; initialized_at is sticky", async () => {
    await corpus.ensureSource({ kind: "robomaster", name: "RM2", siteUrl: "https://y/" }, now);
    const rows = await db.select().from(sources);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "RM2", initializedAt: null });
    await corpus.markChecked(later(1000));
    await corpus.markChecked(later(2000));
    const [s] = await db.select().from(sources);
    expect(s!.initializedAt?.getTime()).toBe(T0 + 1000);
    expect(s!.lastCheckedAt?.getTime()).toBe(T0 + 2000);
  });

  it("start/finish/abandon", async () => {
    const run = await corpus.startRun("startup", now);
    expect((await db.select().from(pollRuns))[0]).toMatchObject({
      status: "running",
      trigger: "startup",
    });
    await corpus.finishRun(
      run,
      {
        listed: 3,
        discovered: 1,
        fetched: 0,
        skipped: 0,
        failed: 0,
        refreshed: 0,
        error: "x".repeat(600),
      },
      later(5),
    );
    const finished = (await db.select().from(pollRuns))[0]!;
    expect(finished.status).toBe("failed");
    expect(finished.listed).toBe(3);
    expect(finished.error?.length).toBe(501); // 500 chars + ellipsis
    await corpus.startRun("scheduled", now);
    expect(await corpus.abandonRunning(later(9))).toBe(1);
    expect(await corpus.abandonRunning(later(9))).toBe(0);
  });

  it("advanceBackfill writes the cursor as given", async () => {
    await corpus.advanceBackfill(4, later(1), now);
    const [s] = await db.select().from(sources);
    expect(s).toMatchObject({ backfillNextPage: 4 });
    expect(s!.backfillCompletedAt?.getTime()).toBe(T0 + 1);
  });
});

describe("discover", () => {
  it("inserts with tags and title parts, then no-ops on the same page", async () => {
    const page = [
      listed("1", {
        title: "【RM2026-开源】某大学战队 步兵控制",
        tags: ["硬件/机器人硬件"],
        introduction: "简介",
      }),
      listed("2", { isPinned: true, listingPosition: 1 }),
      listed("3", { listingPosition: 2 }),
    ];
    expect(await corpus.discover(page, now)).toBe(3);
    const a = await rowOf("1");
    expect(a).toMatchObject({
      status: "pending",
      canonicalUrl: articleUrl("1"),
      titleSeason: "RM2026",
      titleLabels: ["开源"],
      introduction: "简介",
    });
    expect(a.urlHash).toHaveLength(64);
    expect(await db.select().from(articleTags)).toHaveLength(1);
    const before = await digestTables(db);
    expect(await corpus.discover(page, later(1000))).toBe(0);
    expect(await digestTables(db)).toEqual(before);
    // a changed listing updates listing columns only; tags untouched; introduction COALESCEd
    expect(
      await corpus.discover(
        [listed("1", { isPinned: true, introduction: "new", tags: ["x/y"] })],
        later(2000),
      ),
    ).toBe(0);
    const b = await rowOf("1");
    expect(b).toMatchObject({ isPinned: true, introduction: "简介", updatedAt: later(2000) });
    expect(await db.select().from(articleTags)).toHaveLength(1);
  });

  it("is one transaction per page", async () => {
    const bad = listed("9", { tags: ["a", "a"] }); // duplicate tag → ON CONFLICT DO NOTHING, fine
    expect(await corpus.discover([bad], now)).toBe(1);
    const broken = { ...listed("10"), title: null as unknown as string }; // NOT NULL violation on item 2
    await expect(corpus.discover([listed("11"), broken], now)).rejects.toThrow();
    expect(await db.select().from(articles)).toHaveLength(1);
  });

  it("back-fills dangling link targets forwards, only when a row was new", async () => {
    await corpus.discover([listed("2")], now);
    const b = await idOf("2");
    await corpus.storeDetail(
      b,
      detailOf(listed("2"), {
        raw: `<p>${"字".repeat(120)}</p><a href="https://bbs.robomaster.com/article/1">A</a>`,
      }),
      now,
    );
    expect((await db.select().from(articleLinks))[0]?.targetArticleId).toBeNull();
    await corpus.discover([listed("1")], later(1));
    const a = await idOf("1");
    expect((await db.select().from(articleLinks))[0]?.targetArticleId).toBe(a);
  });
});

describe("storeDetail", () => {
  it("writes everything in one transaction and keeps the alignment CHECK", async () => {
    await corpus.discover([listed("1", { tags: ["旧/标签"], author: "listed-author" })], now);
    const id = await idOf("1");
    const detail = detailOf(
      listed("1", { author: null, introduction: "intro", tags: ["新/标签", "第二"] }),
      {
        raw: `<h1>文章 1</h1><p>${"内容".repeat(60)}</p><a href="https://github.com/a/b">repo</a><img src="https://cdn/x.png" alt="图">`,
      },
    );
    const { changed } = await corpus.storeDetail(id, detail, later(1));
    expect(changed).toBe(true);
    const row = await rowOf("1");
    expect(row).toMatchObject({
      status: "fetched",
      author: "listed-author", // COALESCE keeps the discovered author
      introduction: "intro",
      contentFormat: "html",
      parserVersion: "rm-api-v5",
      titleTopic: "文章 1",
    });
    expect(row.contentHtml).toContain("github.com/a/b");
    expect(row.contentHtml?.startsWith("<h1>")).toBe(false); // duplicate title heading stripped
    expect(row.fetchedAt?.getTime()).toBe(T0 + 1);
    expect(row.contentChangedAt?.getTime()).toBe(T0 + 1);
    expect((await db.select().from(articleTags)).map((t) => t.tag)).toEqual(["新/标签", "第二"]);
    expect(await db.select().from(articleLinks)).toMatchObject([
      { kind: "repository", position: 0 },
    ]);
    expect(await db.select().from(articleImages)).toMatchObject([{ alt: "图", position: 0 }]);
    const search = (await db.select().from(articleSearch))[0]!;
    expect(search.tags).toBe("新/标签 第二");
    expect(search.author).toBe(""); // detail author null → ''
    expect(search.document.length).toBe(
      search.title.length +
        search.author.length +
        search.tags.length +
        search.introduction.length +
        search.bodyText.length +
        4,
    );
  });

  it("same detail twice: identical rows except timestamps; content_changed_at untouched", async () => {
    await corpus.discover([listed("1")], now);
    const id = await idOf("1");
    const detail = detailOf(listed("1"));
    await corpus.storeDetail(id, detail, later(1));
    const before = await digestTables(db, ["article_tags", "article_search", "article_images"]);
    const { changed } = await corpus.storeDetail(id, detail, later(2));
    expect(changed).toBe(false);
    const row = await rowOf("1");
    expect(row.contentChangedAt?.getTime()).toBe(T0 + 1);
    expect(row.fetchedAt?.getTime()).toBe(T0 + 2);
    expect(await digestTables(db, ["article_tags", "article_search", "article_images"])).toEqual(
      before,
    );
    const { changed: c2 } = await corpus.storeDetail(
      id,
      detailOf(listed("1"), { bodyText: "不同的正文".repeat(30) }),
      later(3),
    );
    expect(c2).toBe(true);
    expect((await rowOf("1")).contentChangedAt?.getTime()).toBe(T0 + 3);
  });

  it("is atomic: a failing search row leaves the article pending", async () => {
    await corpus.discover([listed("1")], now);
    const id = await idOf("1");
    // A tag longer than the search fold can align? No — break it with a NOT NULL: title null in the detail.
    const bad = { ...detailOf(listed("1")), title: null as unknown as string };
    await expect(corpus.storeDetail(id, bad, later(1))).rejects.toThrow();
    const row = await rowOf("1");
    expect(row.status).toBe("pending");
    expect(await db.select().from(articleSearch)).toHaveLength(0);
  });

  it("image upsert keeps AI captions; dropped URLs go; zero images clears", async () => {
    await corpus.discover([listed("1")], now);
    const id = await idOf("1");
    const img = (n: number, alt: string) => `<img src="https://cdn/${n}.png" alt="${alt}">`;
    const body = `<p>${"字".repeat(120)}</p>`;
    await corpus.storeDetail(
      id,
      detailOf(listed("1"), { raw: body + img(1, "a") + img(2, "b") }),
      later(1),
    );
    await db.update(articleImages).set({ caption: "AI 说明", imageKind: "diagram" });
    await corpus.storeDetail(id, detailOf(listed("1"), { raw: body + img(2, "b2") }), later(2));
    const imgs = await db.select().from(articleImages);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({
      url: "https://cdn/2.png",
      alt: "b2",
      position: 0,
      caption: "AI 说明",
      imageKind: "diagram",
    });
    await corpus.storeDetail(id, detailOf(listed("1"), { raw: body }), later(3));
    expect(await db.select().from(articleImages)).toHaveLength(0);
  });

  it("tags: replaced when the detail carries tags, kept when it carries none", async () => {
    await corpus.discover([listed("1", { tags: ["a/b"] })], now);
    const id = await idOf("1");
    await corpus.storeDetail(id, detailOf(listed("1", { tags: [] })), later(1));
    expect((await db.select().from(articleTags)).map((t) => t.tag)).toEqual(["a/b"]);
    await corpus.storeDetail(id, detailOf(listed("1", { tags: ["c/d"] })), later(2));
    expect((await db.select().from(articleTags)).map((t) => t.tag)).toEqual(["c/d"]);
  });
});

describe("marks and the ladder", () => {
  it("nextWork: refresh beats pending beats backfill; failed rows return after an hour; skipped never", async () => {
    await corpus.discover(
      [
        listed("old", { publishedAt: later(-3 * 86_400_000) }),
        listed("new", { publishedAt: later(-86_400_000), listingPosition: 1 }),
        listed("tie", { publishedAt: later(-86_400_000), listingPosition: 0 }),
      ],
      now,
    );
    let w = await corpus.nextWork(now, { refresh: true, fetch: true, backfill: true });
    expect(w).toMatchObject({ kind: "fetch", article: { sourceArticleId: "tie" } }); // same date, lower position first
    await corpus.markSkipped(await idOf("tie"), "pinned", now);
    await corpus.markFailed(await idOf("new"), "boom", now);
    w = await corpus.nextWork(now, { refresh: true, fetch: true, backfill: true });
    expect(w).toMatchObject({ kind: "fetch", article: { sourceArticleId: "old" } });
    expect((await rowOf("new")).lastError).toBe("boom");
    await corpus.storeDetail(await idOf("old"), detailOf(listed("old")), now);
    w = await corpus.nextWork(now, { refresh: true, fetch: true, backfill: true });
    expect(w).toEqual({ kind: "backfill", nextPage: 2 }); // failed row not due yet, skipped never
    w = await corpus.nextWork(later(3_600_001), { refresh: true, fetch: true, backfill: true });
    expect(w).toMatchObject({ kind: "fetch", article: { sourceArticleId: "new" } });
    // a refresh request beats everything; disabled rungs are omitted
    expect(await noteArticleRead(db, await idOf("old"), later(25 * 3_600_000))).toBe(true);
    w = await corpus.nextWork(later(25 * 3_600_000), {
      refresh: true,
      fetch: true,
      backfill: true,
    });
    expect(w).toMatchObject({ kind: "refresh", article: { sourceArticleId: "old" } });
    w = await corpus.nextWork(later(25 * 3_600_000), {
      refresh: false,
      fetch: false,
      backfill: true,
    });
    expect(w).toEqual({ kind: "backfill", nextPage: 2 });
    await corpus.advanceBackfill(3, now, now);
    expect(await corpus.nextWork(now, { refresh: false, fetch: false, backfill: true })).toEqual({
      kind: "idle",
    });
    expect(await corpus.nextWork(now, { refresh: false, fetch: false, backfill: false })).toEqual({
      kind: "idle",
    });
  });

  it("noteArticleRead: once per 24 h, fetched only", async () => {
    await corpus.discover([listed("1"), listed("2")], now);
    const id = await idOf("1");
    expect(await noteArticleRead(db, id, later(25 * 3_600_000))).toBe(false); // pending
    await corpus.storeDetail(id, detailOf(listed("1")), now);
    expect(await noteArticleRead(db, id, later(23 * 3_600_000))).toBe(false); // fresh
    expect(await noteArticleRead(db, id, later(25 * 3_600_000))).toBe(true);
    expect(await noteArticleRead(db, id, later(26 * 3_600_000))).toBe(false); // already requested
    expect(await noteArticleRead(db, "01J00000000000000000000000", now)).toBe(false);
    await corpus.finishRefreshFailed(id, "nope", later(27 * 3_600_000));
    const row = await rowOf("1");
    expect(row).toMatchObject({ status: "fetched", refreshRequestedAt: null, lastError: "nope" });
    expect(row.contentRaw).not.toBeNull();
    expect(rowsOf(await db.execute(sql`select count(*) as n from article_search`))[0]?.n).toBe(1);
  });
});
