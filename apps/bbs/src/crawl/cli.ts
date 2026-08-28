/**
 * argv arms for main.ts. Each builds its own db (no HTTP app), so `work`
 * never imports Hono and `migrate` never imports the crawler's loops.
 *
 *   bbs migrate            ensureDatabase → migrate → rederive (versions differ only)     exit 0 | 1
 *   bbs rederive [--force] rederive, print RederiveReport                                 exit 0 | 1
 *   bbs work [--once]      createCrawler(...).work(signal) | .once()
 *                          once: exit 0 | 1 (outcome.error) · work: exit 0 on SIGTERM, 3 when the lock is held
 *
 * Config comes from loadConfig(env) — the same env as `bbs` (Frame 2). Nothing
 * in crawl/ reads the environment; this file passes values down. `work` never
 * migrates (bbs-migrate ran first); it fails fast when the schema is behind.
 */
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";

import { loadConfig } from "../config.ts";
import type { BbsDb } from "../db/index.ts";
import { createDb, ensureDatabase, migrate } from "../db/index.ts";
import type { CliDeps } from "../import/cli.ts";
import { maskUrl } from "../import/cli.ts";
import { WorkerLockHeldError, createCrawler } from "./index.ts";
import type { RederiveReport } from "./rederive.ts";
import { rederive } from "./rederive.ts";

export interface WorkCliDeps extends CliDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Process signals to treat as shutdown; tests pass an AbortSignal instead. */
  readonly signal?: AbortSignal;
}

const io = (deps: CliDeps) => ({
  out: deps.stdout ?? ((line: string) => console.log(line)),
  err: deps.stderr ?? ((line: string) => console.error(line)),
});

export async function runMigrateCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2> {
  const { out, err } = io(deps);
  if (argv.length > 0) {
    err("usage: bbs migrate");
    return 2;
  }
  const config = loadConfig(deps.env);
  out(`bbs migrate  target=${maskUrl(config.databaseUrl)}`);
  if (config.createDatabase) await ensureDatabase(config.databaseUrl);
  const db = await createDb(config.databaseUrl);
  try {
    await migrate(db);
    out("migrations applied");
    const report = await rederive(db);
    for (const line of formatRederive(report)) out(line);
    return 0;
  } catch (e) {
    err(`bbs migrate: ${(e as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
}

export async function runRederiveCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2> {
  const { out, err } = io(deps);
  let force = false;
  try {
    const parsed = parseArgs({ args: [...argv], options: { force: { type: "boolean" } } });
    force = parsed.values.force ?? false;
  } catch (e) {
    err(`bbs rederive: ${(e as Error).message}`);
    err("usage: bbs rederive [--force]");
    return 2;
  }
  const config = loadConfig(deps.env);
  const db = await createDb(config.databaseUrl);
  try {
    await assertMigrated(db);
    const report = await rederive(db, { force });
    for (const line of formatRederive(report)) out(line);
    return 0;
  } catch (e) {
    err(`bbs rederive: ${(e as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
}

export async function runWorkCli(
  argv: readonly string[],
  deps: WorkCliDeps,
): Promise<0 | 1 | 2 | 3> {
  const { out, err } = io(deps);
  let once = false;
  try {
    const parsed = parseArgs({ args: [...argv], options: { once: { type: "boolean" } } });
    once = parsed.values.once ?? false;
  } catch (e) {
    err(`bbs work: ${(e as Error).message}`);
    err("usage: bbs work [--once]");
    return 2;
  }
  const config = loadConfig(deps.env);
  const db = await createDb(config.databaseUrl);
  let lockDb: BbsDb | undefined;
  try {
    await assertMigrated(db);
    const log = (line: string) => out(`[bbs-worker] ${line}`);
    if (once) {
      const crawler = createCrawler({ db, fetch: deps.fetch, log });
      const o = await crawler.once();
      out(
        `once: listed ${o.listed}, discovered ${o.discovered}, fetched ${o.fetched}, skipped ${o.skipped}, failed ${o.failed}, refreshed ${o.refreshed}${o.error ? `, error: ${o.error}` : ""}`,
      );
      return o.error ? 1 : 0;
    }
    lockDb = db.host === "postgres" ? await createDb(config.databaseUrl) : undefined;
    const crawler = createCrawler({ db, lockDb, fetch: deps.fetch, log });
    const ac = new AbortController();
    const stop = () => ac.abort();
    if (deps.signal) deps.signal.addEventListener("abort", stop, { once: true });
    else {
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }
    try {
      await crawler.work(ac.signal);
      return 0;
    } catch (e) {
      if (e instanceof WorkerLockHeldError) {
        err(`bbs work: ${e.message}`);
        return 3;
      }
      throw e;
    }
  } catch (e) {
    err(`bbs work: ${(e as Error).message}`);
    return 1;
  } finally {
    await lockDb?.close();
    await db.close();
  }
}

/** `work`/`rederive` never migrate: a schema behind the code is an operator error, reported before any request. */
async function assertMigrated(db: BbsDb): Promise<void> {
  try {
    await db.execute(sql`select 1 from corpus_versions limit 1`);
  } catch {
    throw new Error("database is not migrated: run `bbs migrate` first");
  }
}

/** Pure; exported for the test. */
export function formatRederive(r: RederiveReport): string[] {
  if (r.skipped) {
    return [
      `rederive: up to date (render ${r.to.render}, normalize ${r.to.normalize}, title ${r.to.title})`,
    ];
  }
  return [
    `rederive: ${r.articles} articles; changed content_html ${r.changed.contentHtml}, title parts ${r.changed.titleParts}, article documents ${r.changed.articleDocument}, kb documents ${r.changed.kbDocument}`,
  ];
}
