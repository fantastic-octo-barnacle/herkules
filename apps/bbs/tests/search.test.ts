/** Ranked search over the trgm index: recall, folding, scope, ranking, snippets, rank cursors, errors. */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { Library } from "../src/library/index.ts";
import type { ArticleId, Cursor, SearchHit } from "../src/library/types.ts";
import { ID, seedLibrary } from "./seed.ts";

let seeded: Awaited<ReturnType<typeof seedLibrary>>;
let lib: Library;

beforeAll(async () => {
  seeded = await seedLibrary();
  lib = seeded.library;
});
afterAll(() => seeded.close());

const ids = (hits: readonly SearchHit[]) => hits.map((h) => h.id);
const marked = (hit: SearchHit) =>
  hit.snippet?.map((s) => (s.hit ? `[${s.text}]` : s.text)).join("");

describe("search()", () => {
  it("finds a two-character term anywhere (no floor) and echoes the terms", async () => {
    const page = await lib.search({ q: "步兵", limit: 10 });
    expect(new Set(ids(page.items))).toEqual(new Set([ID.A, ID.B, ID.H, ID.J]));
    expect(page.terms).toEqual(["步兵"]);
    expect(page.nextCursor).toBeNull();
  });

  it("ANDs terms: a second term narrows", async () => {
    expect(ids((await lib.search({ q: "步兵 底盘", limit: 10 })).items)).toEqual([ID.A]);
    expect((await lib.search({ q: "步兵 不存在", limit: 10 })).items).toEqual([]);
  });

  it("is case- and width-insensitive without any SQL fold", async () => {
    for (const q of ["hpm5361", "HPM5361", "ｈｐｍ5361", "（pro", "(Pro", "pro 版)"]) {
      expect(ids((await lib.search({ q, limit: 10 })).items)).toEqual([ID.A]);
    }
  });

  it("scope=title matches the folded title slice only; scope=kb searches kb_search", async () => {
    expect(
      new Set(ids((await lib.search({ q: "步兵", scope: "title", limit: 10 })).items)),
    ).toEqual(new Set([ID.A, ID.H]));
    expect(ids((await lib.search({ q: "hpm5361", scope: "title", limit: 10 })).items)).toEqual([
      ID.A,
    ]);
    const kb = await lib.search({ q: "m3508", scope: "kb", limit: 10 });
    expect(new Set(ids(kb.items))).toEqual(new Set([ID.A, ID.B]));
    expect(kb.items.every((h) => h.snippet?.some((s) => s.hit && s.text === "M3508"))).toBe(true);
  });

  it("ranks: title+body hits above a body-only hit; more occurrences above fewer", async () => {
    const infantry = await lib.search({ q: "步兵", limit: 10 });
    const order = ids(infantry.items);
    expect(order[0]).toBe(ID.A); // title, intro and body
    expect(order.indexOf(ID.H)).toBeLessThan(order.indexOf(ID.J)); // title hit vs one body mention
    for (let i = 1; i < infantry.items.length; i++) {
      expect(infantry.items[i - 1]!.score).toBeGreaterThanOrEqual(infantry.items[i]!.score);
    }
    const motors = await lib.search({ q: "电机", limit: 10 });
    expect(ids(motors.items)[0]).toBe(ID.F); // 电机 ×6 in title/intro/body
    expect(motors.items.every((h) => h.score > 0)).toBe(true);
  });

  it("attaches snippets cut from the raw fields, prose first", async () => {
    const hit = (await lib.search({ q: "整定", limit: 10 })).items.find((h) => h.id === ID.B)!;
    expect(marked(hit)).toContain("[整定]");
    expect(hit.snippet!.some((s) => s.hit && s.text === "整定")).toBe(true);
    const a = (await lib.search({ q: "hpm5361", limit: 10 })).items[0]!;
    // Matched on the fold, emitted from the raw text: the body's ASCII spelling or the title's full-width one.
    expect(a.snippet!.filter((s) => s.hit).map((s) => s.text)).toContain("HPM5361");
    // Author-only match: no snippet material.
    const author = (await lib.search({ q: "zhou", limit: 10 })).items[0]!;
    expect(author.id).toBe(ID.K);
    expect(author.snippet).toBeNull();
  });

  it("filters by tag/group alongside the match", async () => {
    expect(ids((await lib.search({ q: "步兵", group: "机械", limit: 10 })).items).sort()).toEqual(
      [ID.H, ID.J].sort(),
    );
    expect(ids((await lib.search({ q: "步兵", tag: "开源/PCB", limit: 10 })).items)).toEqual([
      ID.A,
    ]);
  });

  it("pages the ranking by (score, id) with no duplicates and no gaps", async () => {
    const all = ids((await lib.search({ q: "步兵", limit: 10 })).items);
    for (const limit of [1, 2, 3]) {
      const seen: ArticleId[] = [];
      let cursor: Cursor | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await lib.search({ q: "步兵", limit, cursor });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...ids(page.items));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(all);
    }
  });

  it("throws QueryError for a blank query and for a foreign cursor", async () => {
    await expect(lib.search({ q: '  "" ', limit: 10 })).rejects.toMatchObject({
      code: "empty_query",
    });
    const feed = await lib.articles({ limit: 1 });
    await expect(
      lib.search({ q: "步兵", limit: 1, cursor: feed.nextCursor! }),
    ).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("never returns a skipped article even though it has a search row", async () => {
    expect((await lib.search({ q: "跳过", limit: 10 })).items).toEqual([]);
    expect((await lib.search({ q: "nobody", limit: 10 })).items).toEqual([]);
  });

  it("neutralises LIKE metacharacters in terms", async () => {
    expect((await lib.search({ q: "%", limit: 10 })).items).toEqual([]);
    expect((await lib.search({ q: "_", limit: 10 })).items).toEqual([]);
  });
});
