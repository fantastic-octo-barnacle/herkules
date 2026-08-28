/**
 * The import end to end on PGlite: load, verify, no-op, delta, dry-run,
 * --user-map, the derived columns, and a read-back that disagrees.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createDb, migrate, rowsOf } from "../src/db/index.ts";
import { articles } from "../src/db/schema.ts";
import type { BbsDb } from "../src/db/index.ts";
import { formatReport, maskUrl, runImportCli } from "../src/import/cli.ts";
import { runImport } from "../src/import/run.ts";
import { SKIPPED, TABLES, checkSource } from "../src/import/tables.ts";
import { FIXTURE, T0, buildFixtureDb, fixtureId } from "./fixture.ts";

const count = async (db: BbsDb, table: string) =>
  Number(rowsOf(await db.execute(sql.raw(`select count(*)::int as n from "${table}"`)))[0]?.n);

describe("bbs import", () => {
  let dir: string;
  let sqlitePath: string;
  let db: BbsDb;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bbs-import-"));
    sqlitePath = await buildFixtureDb(dir);
    db = await createDb("pglite://memory");
    await migrate(db);
  });
  afterAll(() => db.close());

  it("accepts the fixture as an rm-wenku database", () => {
    expect(checkSource(sqlitePath)).toEqual({ versions: [1, 2, 3, 4, 5, 6], strangers: [] });
    expect(TABLES.map((t) => t.name)).toHaveLength(13);
    expect(Object.keys(SKIPPED)).toEqual(["users", "sessions", "api_tokens"]);
  });

  it("dry-run hashes every table and writes nothing", async () => {
    const report = await runImport({ db, sqlitePath, dryRun: true });
    expect(report.ok).toBe(true);
    expect(report.runId).toBeNull();
    expect(Object.fromEntries(report.tables.map((t) => [t.table, t.rows]))).toEqual(FIXTURE.counts);
    expect(await count(db, "articles")).toBe(0);
    expect(await count(db, "import_runs")).toBe(0);
    expect(report.skipped).toEqual([
      { table: "users", rows: 1, reason: SKIPPED.users },
      { table: "sessions", rows: 1, reason: SKIPPED.sessions },
      { table: "api_tokens", rows: 0, reason: SKIPPED.api_tokens },
    ]);
  });

  it("loads, derives, verifies before commit and records the run", async () => {
    const events: string[] = [];
    const report = await runImport({
      db,
      sqlitePath,
      onProgress: (e) => events.push(`${e.phase}:${e.table}`),
    });
    expect(report.ok).toBe(true);
    expect(report.noop).toBe(false);
    expect(report.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(report.tables.every((t) => t.verified)).toBe(true);
    for (const [table, n] of Object.entries(FIXTURE.counts)) expect(await count(db, table)).toBe(n);
    expect(events.filter((e) => e.startsWith("verify:"))).toHaveLength(13);
    expect(report.notes).toContain(
      `ai_usage: 1 row had an unmapped user_id (${FIXTURE.unmappedUserId}) -> NULL`,
    );
    expect(report.tables.find((t) => t.table === "articles")?.derived).toBe(
      `+${FIXTURE.renderedArticles} content_html`,
    );
    expect(report.tables.find((t) => t.table === "article_links")?.derived).toBe(
      `+${FIXTURE.resolvedLinks} target_article_id`,
    );

    // Derived columns.
    const a1 = rowsOf(
      await db.execute(
        sql`select content_html, title_labels, is_pinned, published_at from articles where id = ${fixtureId(1)}`,
      ),
    )[0]!;
    expect(String(a1.content_html)).toContain("<b>PID</b>");
    expect(String(a1.content_html)).not.toMatch(
      /<script|onerror|data-w-e-type|evil\.example\/x"><\/iframe>/,
    );
    expect(String(a1.content_html)).toContain(
      `<a href="https://bbs.robomaster.com/article/2002" target="_blank" rel="noopener noreferrer nofollow">[1] 云台 PID 整定笔记 &lt;A&amp;B&gt;</a>`,
    );
    expect(String(a1.content_html).startsWith('<p style="text-align: center">')).toBe(true); // duplicate h1 stripped
    expect(a1.title_labels).toEqual(["开源"]);
    expect(a1.is_pinned).toBe(true);
    // Raw `db.execute` hands timestamptz back as text on PGlite; the query builder (mode "date") yields Date.
    expect(new Date(String(a1.published_at)).getTime()).toBe(T0 + 86_400_000);
    const a2 = rowsOf(
      await db.execute(sql`select content_html from articles where id = ${fixtureId(2)}`),
    )[0]!;
    expect(String(a2.content_html)).toMatch(/^<p>经验上 <em>PID<\/em>/);
    expect(String(a2.content_html)).toContain('<input type="checkbox" checked disabled />');
    const skipped = rowsOf(
      await db.execute(
        sql`select content_html, content_raw from articles where id = ${fixtureId(3)}`,
      ),
    )[0]!;
    expect(skipped).toEqual({ content_html: null, content_raw: null });

    const links = rowsOf(
      await db.execute(
        sql`select url, target_article_id from article_links where article_id = ${fixtureId(1)} order by position`,
      ),
    );
    expect(links.map((l) => l.target_article_id)).toEqual([null, fixtureId(2), fixtureId(3), null]);

    const tags = rowsOf(
      await db.execute(
        sql`select tag, position, group_name from article_tags where article_id = ${fixtureId(1)} order by position`,
      ),
    );
    expect(tags).toEqual([
      { tag: "硬件/机器人硬件", position: 0, group_name: "硬件" },
      { tag: "电控/电机", position: 1, group_name: "电控" },
    ]);

    const doc = rowsOf(
      await db.execute(
        sql`select document, title from article_search where article_id = ${fixtureId(1)}`,
      ),
    )[0]!;
    expect(
      String(doc.document).startsWith(
        "【rm2026-开源】步兵底盘 hpm5361 方案\nkaiser\n硬件/机器人硬件 电控/电机\n简介:全国产方案\n",
      ),
    ).toBe(true);
    expect(String(doc.document)).toContain("全国产 方案(pro版)"); // width folded, length preserved
    expect(String(doc.document).length).toBe(
      String(doc.title).length +
        "Kaiser".length +
        "硬件/机器人硬件 电控/电机".length +
        "简介：全国产方案".length +
        "大学步兵开源底盘，PID 整定经验。参考文献 [1] 全国产　方案（Ｐｒｏ版）".length +
        4,
    );
    const kb = rowsOf(
      await db.execute(sql`select document from kb_search where article_id = ${fixtureId(1)}`),
    )[0]!;
    expect(String(kb.document)).toContain("hpm5361 mcu 主控");

    const usage = rowsOf(await db.execute(sql`select id, user_id from ai_usage order by id`));
    expect(usage.map((u) => u.user_id)).toEqual([null, null]);
    const ai = rowsOf(
      await db.execute(
        sql`select article_id, status, overview_json ->> 'tldr' as tldr, kb_json -> 'domain' as domain from article_ai order by article_id`,
      ),
    );
    expect(ai[0]).toEqual({
      article_id: fixtureId(1),
      status: "ready",
      tldr: "全国产步兵底盘方案，HPM5361 主控",
      domain: ["机械", "电控"],
    });
    expect(await count(db, "import_runs")).toBe(1);

    const printed = formatReport(report, false);
    expect(printed[0]).toMatch(/table\s+rows\s+checksum\s+status/);
    expect(printed.find((l) => l.includes("articles "))).toMatch(
      /articles\s+12\s+[0-9a-f]{12}\s+ok\s+\(\+11 content_html\)/,
    );
    expect(printed.at(-1)).toMatch(
      /^ok {2}13 tables, \d+ rows, [\d.]+ s {2}\(verified before commit; run /,
    );
  });

  it("is a no-op on the same dump, and opens no transaction", async () => {
    const before = rowsOf(
      await db.execute(sql`select id, started_at from import_runs where not noop`),
    );
    const tx = vi.spyOn(db, "transaction");
    const report = await runImport({ db, sqlitePath });
    tx.mockRestore();
    expect(report.noop).toBe(true);
    expect(report.ok).toBe(true);
    expect(tx).not.toHaveBeenCalled();
    expect(report.previousRunId).toBe(before[0]?.id);
    expect(await count(db, "import_runs")).toBe(2);
    expect(
      rowsOf(
        await db.execute(sql`select noop from import_runs order by started_at desc limit 1`),
      )[0]?.noop,
    ).toBe(true);
    expect(formatReport(report, false)[0]).toMatch(
      /^no-op {2}digests and versions equal run .* \(render 1, normalize 1\)$/,
    );
  });

  it("a different --user-map is a different corpus: the mapped sub lands", async () => {
    const report = await runImport({
      db,
      sqlitePath,
      userMap: new Map([[FIXTURE.unmappedUserId, "usr_new"]]),
    });
    expect(report.noop).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.notes.some((n) => n.includes("unmapped"))).toBe(false);
    const usage = rowsOf(await db.execute(sql`select user_id from ai_usage where kind = 'chat'`));
    expect(usage[0]?.user_id).toBe("usr_new");
  });

  it("a newer dump lands as a delta (truncate-and-reload)", async () => {
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite
      .prepare("UPDATE articles SET title = ? WHERE id = ?")
      .run("裁判系统通信协议解析（更新）", fixtureId(12));
    sqlite.prepare("DELETE FROM article_tags WHERE article_id = ?").run(fixtureId(11));
    sqlite.close();
    const report = await runImport({
      db,
      sqlitePath,
      userMap: new Map([[FIXTURE.unmappedUserId, "usr_new"]]),
    });
    expect(report.noop).toBe(false);
    expect(report.ok).toBe(true);
    expect(
      rowsOf(await db.execute(sql`select title from articles where id = ${fixtureId(12)}`))[0]
        ?.title,
    ).toBe("裁判系统通信协议解析（更新）");
    expect(await count(db, "article_tags")).toBe(FIXTURE.counts.article_tags - 1);
  });

  it("a read-back that disagrees rolls back and leaves the previous corpus serving", async () => {
    // Corrupt ONE loaded row on its way into Postgres, after the digest pass hashed the source.
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, "transaction")
      .mockImplementation((fn) => original((tx) => fn(corrupting(tx))));
    // Also change the source so it is not a no-op.
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite.prepare("UPDATE articles SET author = 'Ivan II' WHERE id = ?").run(fixtureId(12));
    sqlite.close();
    const report = await runImport({
      db,
      sqlitePath,
      userMap: new Map([[FIXTURE.unmappedUserId, "usr_new"]]),
    });
    spy.mockRestore();
    expect(report.ok).toBe(false);
    expect(report.noop).toBe(false);
    expect(report.error).toMatch(/^articles: read-back/);
    expect(report.tables.find((t) => t.table === "articles")?.verified).toBe(false);
    // Rolled back: the author change did not land, the corpus is intact, and the failure is on record.
    expect(
      rowsOf(await db.execute(sql`select author from articles where id = ${fixtureId(12)}`))[0]
        ?.author,
    ).toBe("Ivan");
    expect(await count(db, "articles")).toBe(FIXTURE.counts.articles);
    const last = rowsOf(
      await db.execute(sql`select ok, notes from import_runs order by started_at desc limit 1`),
    )[0]!;
    expect(last.ok).toBe(false);
    expect(JSON.stringify(last.notes)).toContain("verify failed");
    expect(formatReport(report, false).at(-1)).toMatch(/^FAILED {2}articles: read-back/);
  });

  it("refuses a source it does not know", async () => {
    const strangerDir = mkdtempSync(join(tmpdir(), "bbs-import-stranger-"));
    const path = await buildFixtureDb(strangerDir);
    const sqlite = new DatabaseSync(path);
    sqlite.exec("CREATE TABLE favourites (id TEXT)");
    sqlite.close();
    await expect(runImport({ db, sqlitePath: path, dryRun: true })).rejects.toThrow(
      /unknown source tables: favourites/,
    );
    expect(() => checkSource(sqlitePath.replace("app.db", "missing.db"))).toThrow();
  });

  it("the CLI: exit codes and the printer", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const env = {
      PUBLIC_ORIGIN: "http://localhost:3000",
      APP_ORIGIN: "http://localhost:3003",
      DATABASE_URL: `pglite://${join(dir, "cli-pglite")}`,
      BBS_CLIENT_SECRET: "0123456789abcdef",
      BBS_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    };
    const deps = { env, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
    expect(await runImportCli([], deps)).toBe(2);
    expect(await runImportCli([sqlitePath, "--user-map", "nope"], deps)).toBe(2);
    expect(await runImportCli([sqlitePath, "--bogus"], deps)).toBe(2);
    expect(await runImportCli([join(dir, "missing.db")], deps)).toBe(2);
    expect(await runImportCli([sqlitePath, "--dry-run"], deps)).toBe(0);
    expect(out[0]).toMatch(
      /^bbs import {2}source=.*app\.db \([\d.]+ MB, sqlx 1\.\.6\) {2}target=pglite:\/\/.*\(dry run\)$/,
    );
    expect(out.at(-1)).toMatch(/\(dry run; nothing written\)$/);
    out.length = 0;
    expect(
      await runImportCli(
        [sqlitePath, "--batch", "3", "--user-map", `${FIXTURE.unmappedUserId}=usr_x`],
        deps,
      ),
    ).toBe(0);
    expect(out.at(-1)).toMatch(/^ok {2}13 tables/);
    out.length = 0;
    expect(
      await runImportCli(
        [sqlitePath, "--batch", "3", "--user-map", `${FIXTURE.unmappedUserId}=usr_x`],
        deps,
      ),
    ).toBe(0);
    expect(out.at(-1)).toMatch(/^no-op/);
    expect(maskUrl("postgres://u:secret@h/bbs")).toBe("postgres://u:***@h/bbs");
    expect(err.length).toBeGreaterThan(0);
  });
});

/** A BbsDb whose `insert(articles).values(rows)` alters one title; everything else passes through. */
function corrupting(tx: BbsDb): BbsDb {
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== "insert") {
        const v: unknown = Reflect.get(target, key, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (table: PgTable) => ({
        values: (rows: Record<string, unknown>[]) =>
          target
            .insert(table)
            .values(
              table === articles
                ? rows.map((r) =>
                    r.id === fixtureId(9) ? { ...r, title: `${String(r.title)}x` } : r,
                  )
                : rows,
            ),
      });
    },
  });
}
