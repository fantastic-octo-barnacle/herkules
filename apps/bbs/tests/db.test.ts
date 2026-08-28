/**
 * The migration on PGlite: pg_trgm loads, both GIN indexes create, and the
 * alignment CHECK — the invariant the whole search design rests on — is
 * enforced by the database before any query layer exists.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createDb, ensureDatabase, migrate, rowsOf } from "../src/db/index.ts";
import type { BbsDb } from "../src/db/index.ts";
import { articleSearch, articles, sources } from "../src/db/schema.ts";
import { ARTICLE_SEARCH_FIELDS } from "../src/db/search/index.ts";
import { buildDocument } from "../src/import/derive.ts";

const ID = "01J0000000000000000000000A";

describe("migration on pglite", () => {
  let db: BbsDb;
  beforeAll(async () => {
    db = await createDb("pglite://memory");
    await migrate(db);
    await db.insert(sources).values({
      id: "src",
      kind: "bbs",
      name: "RM 论坛",
      siteUrl: "https://bbs.robomaster.com",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await db.insert(articles).values({
      id: ID,
      sourceId: "src",
      sourceArticleId: "1",
      canonicalUrl: "https://bbs.robomaster.com/article/1",
      urlHash: "h1",
      title: "【RM2026-开源】步兵底盘",
      discoveredAt: new Date(0),
      status: "fetched",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  });
  afterAll(() => db.close());

  it("loads pg_trgm and both trigram indexes", async () => {
    const ext = rowsOf(
      await db.execute(sql`select extname from pg_extension where extname = 'pg_trgm'`),
    );
    expect(ext).toHaveLength(1);
    const idx = rowsOf(
      await db.execute(
        sql`select indexname from pg_indexes where indexname in ('article_search_document_trgm','kb_search_document_trgm','articles_feed_idx') order by 1`,
      ),
    );
    expect(idx.map((r) => r.indexname)).toEqual([
      "article_search_document_trgm",
      "articles_feed_idx",
      "kb_search_document_trgm",
    ]);
    const trgm = rowsOf(await db.execute(sql`select show_trgm('步兵') as t`));
    expect(trgm[0]?.t).toHaveLength(3);
  });

  it("is idempotent", async () => {
    await migrate(db);
  });

  it("stores a buildDocument row and finds it by substring on the folded document", async () => {
    const fields = {
      title: "【RM2026-开源】ＨＰＭ5361 步兵底盘",
      author: "Kaiser",
      tags: "硬件/机器人硬件",
      introduction: "简介：全国产　方案",
      bodyText: "大学步兵开源底盘，PID 整定经验。",
    };
    const document = buildDocument(ARTICLE_SEARCH_FIELDS.map((f) => fields[camel(f)]));
    await db.insert(articleSearch).values({ articleId: ID, ...fields, document });
    const hit = rowsOf(
      await db.execute(
        sql`select article_id from article_search where document like ${"%步兵%"} and document like ${"%hpm5361%"} and document like ${"%kaiser%"} and document like ${"%【rm2026-%"} escape '\\'`,
      ),
    );
    expect(hit.map((r) => r.article_id)).toEqual([ID]);
    // Slices of `document` are the folded fields: the title slice is index-aligned with the raw title.
    const slice = rowsOf(
      await db.execute(
        sql`select substr(document, 1, length(title)) as t, substr(document, 1 + length(title) + 1, length(author)) as a from article_search where article_id = ${ID}`,
      ),
    );
    expect(slice[0]).toEqual({ t: "【rm2026-开源】hpm5361 步兵底盘", a: "kaiser" });
  });

  it("rejects a document that is not length-aligned with its fields", async () => {
    const err = await db
      .execute(sql`update article_search set document = document || 'x' where article_id = ${ID}`)
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: Error },
      );
    expect(err).not.toBeNull();
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/article_search_document_aligned/);
  });

  it("generates group_name from the tag", async () => {
    await db.execute(
      sql`insert into article_tags (article_id, tag, position) values (${ID}, '硬件/机器人硬件', 0), (${ID}, '无斜杠', 1)`,
    );
    const rows = rowsOf(
      await db.execute(sql`select tag, group_name from article_tags order by position`),
    );
    expect(rows).toEqual([
      { tag: "硬件/机器人硬件", group_name: "硬件" },
      { tag: "无斜杠", group_name: "无斜杠" },
    ]);
  });

  it("ensureDatabase is a no-op for pglite", async () => {
    expect(await ensureDatabase("pglite://memory")).toBe("skipped");
    expect(await ensureDatabase("postgres://u:p@h/postgres")).toBe("skipped");
  });
});

function camel(f: string): "title" | "author" | "tags" | "introduction" | "bodyText" {
  return f === "body_text" ? "bodyText" : (f as "title" | "author" | "tags" | "introduction");
}
