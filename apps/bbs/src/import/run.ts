/**
 * `bbs import <app.db>` — the whole operation, in one function.
 *
 * It runs on the repo's DATABASE_URL pattern: herkules-old's migrator was
 * written against `pg` (`pool.connect()`, explicit BEGIN/COMMIT, `result.rows`);
 * this repo runs postgres.js in prod and PGlite in tests. Rewriting the four
 * driver-touching functions onto `db.transaction()` + drizzle inserts/selects
 * costs ~80 lines and buys an import that runs end to end in CI with no Docker.
 *
 * ORDER:
 *   1. checkSource(sqlite)         refuse a schema we do not know; run each spec's audits
 *   2. DIGEST PASS                 stream every spec, hash rows -> SourceDigests. This IS --dry-run
 *                                  (no database touched; dry-run checksums equal live-run checksums).
 *   3. NO-OP CHECK                 last `ok` import_runs row: equal digests ∧ equal RENDER_VERSION ∧
 *                                  equal NORMALIZE_VERSION -> record a `noop: true` row, return, exit 0.
 *                                  No transaction is opened. This is done-predicate 1's wording.
 *   4. TRANSACTION                 TRUNCATE the thirteen IMPORTED_TABLES in one statement; per spec in
 *                                  FK order: stream batches of 500 from SQLite, convert(), derive
 *                                  (content_html, target_article_id, document), INSERT multi-row
 *                                  (articles: 30 columns × 500 = 15 000 params, under 65 535).
 *   5. VERIFY BEFORE COMMIT        read back every table, rebuild the digest, compare rows AND checksum;
 *                                  assert content_html IS NOT NULL wherever content_raw is. Mismatch ->
 *                                  throw -> ROLLBACK. herkules-old verified after COMMIT, which leaves a
 *                                  corrupt corpus live while the operator reads the report. Cost: the
 *                                  read-back (~25 MB of values) is held in memory inside the transaction —
 *                                  affordable at this size, and said out loud rather than pretending it scales.
 *   6. SEPARATE TRANSACTION        insert the `import_runs` row, ok true or false. Separate on purpose:
 *                                  a failed import must leave a record, and it cannot if the record is in
 *                                  the transaction that rolled back.
 *
 * IDEMPOTENCE: same dump twice -> one load, then a no-op. Newer dump -> the delta lands
 * (truncate-and-reload is total replacement; no merge logic exists or is needed while v1
 * never writes imported tables). Killed mid-load -> ROLLBACK; the previous corpus is still
 * serving. `TRUNCATE` blocks readers for the ~3 s the load takes; accepted for v1.
 *
 * The digest covers the rows AS LOADED: `--user-map` is applied before hashing, so the
 * read-back compares equal and a different map is a different corpus (not a no-op).
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { RENDER_VERSION, renderArticleHtml } from "../content/render.ts";
import type { RenderLink } from "../content/render.ts";
import type { BbsDb } from "../db/index.ts";
import { rowsOf } from "../db/index.ts";
import { IMPORTED_TABLES, importRuns } from "../db/schema.ts";
import * as schema from "../db/schema.ts";
import { ARTICLE_SEARCH_FIELDS, KB_SEARCH_FIELDS } from "../db/search/index.ts";
import { NORMALIZE_VERSION } from "../db/search/normalize.ts";
import { TableDigest, canonical, convert } from "./convert.ts";
import type { LinkTargetIndex } from "./derive.ts";
import { buildDocument, resolveLinkTarget } from "./derive.ts";
import type { TableSpec } from "./tables.ts";
import { SKIPPED, TABLES, checkOpenSource } from "./tables.ts";

export interface ImportOptions {
  readonly db: BbsDb;
  /** Path to a `wenku backup` copy of `app.db`. Opened `{ readOnly: true }` via node:sqlite. */
  readonly sqlitePath: string;
  /** `--user-map old=sub`, already parsed. */
  readonly userMap?: ReadonlyMap<string, string>;
  readonly batchSize?: number; // default 500
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  /** Progress for the CLI's table printer; never for control flow. */
  readonly onProgress?: (event: ImportProgress) => void;
}

export interface ImportProgress {
  readonly table: string;
  readonly rows: number;
  readonly phase: "digest" | "load" | "verify";
}

export interface TableReport {
  readonly table: string;
  readonly rows: number;
  /** Hex sha256, order-independent, over SOURCE columns only. */
  readonly checksum: string;
  /** False only when the read-back disagreed — which aborted the import. */
  readonly verified: boolean;
  /** Derived-column counts for the printer, e.g. `+905 content_html`. */
  readonly derived?: string;
}

export interface ImportReport {
  readonly ok: boolean;
  /** True when the dump and both versions equal the last ok run: nothing was loaded. */
  readonly noop: boolean;
  /** Null for a dry run. */
  readonly runId: string | null;
  readonly tables: readonly TableReport[];
  readonly skipped: readonly { table: string; rows: number; reason: string }[];
  /** Human-readable findings: unmapped user ids nulled, orphan article ids, oddities. */
  readonly notes: readonly string[];
  readonly durationMs: number;
  readonly renderVersion: string;
  readonly normalizeVersion: string;
  /** Set when the previous ok run was a match (`noop`) or a verify failure aborted the load. */
  readonly previousRunId?: string | null;
  readonly error?: string;
}

/** A read-back that disagreed with the source. Thrown inside the transaction so it rolls back. */
export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

const TARGETS: Readonly<Record<(typeof IMPORTED_TABLES)[number], PgTable>> = {
  sources: schema.sources,
  articles: schema.articles,
  article_tags: schema.articleTags,
  article_links: schema.articleLinks,
  article_images: schema.articleImages,
  poll_runs: schema.pollRuns,
  source_guard_state: schema.sourceGuardState,
  article_ai: schema.articleAi,
  kb_entities: schema.kbEntities,
  article_entities: schema.articleEntities,
  ai_usage: schema.aiUsage,
  article_search: schema.articleSearch,
  kb_search: schema.kbSearch,
};

type SqliteRow = Record<string, unknown>;

interface Digest {
  readonly table: string;
  readonly rows: number;
  readonly checksum: string;
}

/** Throws only on a broken source or an unusable database; a checksum mismatch returns `ok: false` after ROLLBACK. */
export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 500;
  const userMap = options.userMap ?? new Map<string, string>();
  const progress = options.onProgress ?? (() => {});
  const sqlite = new DatabaseSync(options.sqlitePath, { readOnly: true });
  const sourceBytes = statSync(options.sqlitePath).size;
  try {
    // 1. the source
    checkOpenSource(sqlite);
    const skipped = Object.entries(SKIPPED).map(([table, reason]) => ({
      table,
      rows: countRows(sqlite, table),
      reason,
    }));
    const notes: string[] = [];
    for (const spec of TABLES) {
      for (const audit of spec.audits ?? []) {
        const n = Number((sqlite.prepare(audit.sql).get() as { n: number | bigint }).n);
        if (n > 0) notes.push(`${audit.note}: ${n}`);
      }
    }
    const policy = createPolicy(userMap);

    // 2. the digest pass (= dry run)
    const digests: Digest[] = [];
    for (const spec of TABLES) {
      const digest = new TableDigest();
      for (const batch of readBatches(sqlite, spec, batchSize)) {
        for (const row of batch)
          digest.add(canonicalRow(spec, policy.apply(spec, convertRow(spec, row))));
      }
      digests.push({ table: spec.name, rows: digest.rows, checksum: digest.digest() });
      progress({ table: spec.name, rows: digest.rows, phase: "digest" });
    }
    notes.push(...policy.notes());
    const report = (extra: Partial<ImportReport>, verified: (t: string) => boolean) =>
      ({
        ok: true,
        noop: false,
        runId: null,
        tables: digests.map((d) => ({ ...d, verified: verified(d.table) })),
        skipped,
        notes,
        durationMs: performance.now() - started,
        renderVersion: RENDER_VERSION,
        normalizeVersion: NORMALIZE_VERSION,
        ...extra,
      }) satisfies ImportReport;
    if (options.dryRun) return report({}, () => true);

    // 3. the no-op check
    const last = await lastOkRun(options.db);
    if (
      last &&
      sameCorpus(last.tables, digests) &&
      last.renderVersion === RENDER_VERSION &&
      last.normalizeVersion === NORMALIZE_VERSION
    ) {
      const runId = uuidv7(now());
      await recordRun(options.db, {
        id: runId,
        startedAt: now(),
        sourcePath: options.sqlitePath,
        sourceBytes,
        ok: true,
        noop: true,
        tables: digests.map((d) => ({ ...d, verified: true })),
        notes,
      });
      return report({ noop: true, runId, previousRunId: last.id }, () => true);
    }

    // 4 + 5. one transaction: truncate, load, verify
    const runId = uuidv7(now());
    const startedAt = now();
    const derived = new Map<string, string>();
    const verified = new Map<string, boolean>();
    const links = readLinksForRender(sqlite);
    const targets: { byCanonicalUrl: Map<string, string>; bySourceArticleId: Map<string, string> } =
      {
        byCanonicalUrl: new Map(),
        bySourceArticleId: new Map(),
      };
    let failure: VerifyError | null = null;
    try {
      await options.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`TRUNCATE ${IMPORTED_TABLES.map((t) => `"${t}"`).join(", ")}`));
        for (const spec of TABLES) {
          const target = TARGETS[spec.name as keyof typeof TARGETS];
          const keys = keyByDbName(target);
          const counters = { derived: 0 };
          let rows = 0;
          for (const batch of readBatches(sqlite, spec, batchSize)) {
            const values = batch.map((raw) => {
              const converted = policy.apply(spec, convertRow(spec, raw));
              const out: Record<string, unknown> = {};
              for (const c of spec.columns) {
                const v = converted[c.name];
                out[keys.get(c.name)!] =
                  c.kind === "json" && typeof v === "string" ? JSON.parse(v) : v;
              }
              derive(spec.name, converted, out, { links, targets, counters });
              return out;
            });
            await tx.insert(target).values(values);
            rows += values.length;
          }
          progress({ table: spec.name, rows, phase: "load" });
          const label = DERIVED_LABEL[spec.name];
          if (label) derived.set(spec.name, `+${counters.derived} ${label}`);
        }
        // 5. verify before COMMIT
        for (const spec of TABLES) {
          const expected = digests.find((d) => d.table === spec.name)!;
          const back = await readBack(tx, spec);
          const ok = back.rows === expected.rows && back.checksum === expected.checksum;
          verified.set(spec.name, ok);
          progress({ table: spec.name, rows: back.rows, phase: "verify" });
          if (!ok) {
            throw new VerifyError(
              `${spec.name}: read-back ${back.rows} rows / ${back.checksum.slice(0, 12)} != source ${expected.rows} / ${expected.checksum.slice(0, 12)}`,
            );
          }
        }
        const unrendered = rowsOf(
          await tx.execute(
            sql`select count(*)::int as n from articles where content_raw is not null and content_html is null`,
          ),
        );
        if (Number(unrendered[0]?.n ?? 0) > 0) {
          throw new VerifyError(
            `articles: ${String(unrendered[0]?.n)} rows have content_raw but no content_html`,
          );
        }
      });
    } catch (err) {
      if (!(err instanceof VerifyError)) throw err;
      failure = err;
    }

    // 6. the record, in its own transaction
    const tables = digests.map((d) => ({
      ...d,
      verified: verified.get(d.table) ?? false,
      ...(derived.has(d.table) ? { derived: derived.get(d.table) } : {}),
    }));
    await recordRun(options.db, {
      id: runId,
      startedAt,
      sourcePath: options.sqlitePath,
      sourceBytes,
      ok: failure === null,
      noop: false,
      tables,
      notes: failure ? [...notes, `verify failed: ${failure.message}`] : notes,
    });
    return {
      ...report(
        { runId, tables, previousRunId: last?.id ?? null },
        (t) => verified.get(t) ?? false,
      ),
      ok: failure === null,
      ...(failure ? { error: failure.message } : {}),
    };
  } finally {
    sqlite.close();
  }
}

const DERIVED_LABEL: Readonly<Record<string, string>> = {
  articles: "content_html",
  article_links: "target_article_id",
  article_search: "document",
  kb_search: "document",
};

// ── SQLite side ─────────────────────────────────────────────────────────────

function countRows(sqlite: DatabaseSync, table: string): number {
  try {
    return Number(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
    );
  } catch {
    return 0;
  }
}

function* readBatches(
  sqlite: DatabaseSync,
  spec: TableSpec,
  batchSize: number,
): Generator<SqliteRow[]> {
  const query =
    spec.source ??
    `SELECT ${spec.columns.map((c) => `"${c.name}"`).join(", ")} FROM "${spec.name}"`;
  let batch: SqliteRow[] = [];
  for (const row of sqlite.prepare(query).iterate()) {
    batch.push(row as SqliteRow);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

function convertRow(spec: TableSpec, row: SqliteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of spec.columns) out[c.name] = convert(spec.name, c, row[c.name]);
  return out;
}

function canonicalRow(spec: TableSpec, row: Record<string, unknown>): string[] {
  return spec.columns.map((c) => canonical(c, row[c.name]));
}

/** The `[n]` reference markers need each article's links while `articles` is still loading (links come later in FK order). */
function readLinksForRender(sqlite: DatabaseSync): ReadonlyMap<string, RenderLink[]> {
  const map = new Map<string, RenderLink[]>();
  for (const row of sqlite
    .prepare("SELECT article_id, url, label FROM article_links ORDER BY article_id, position")
    .iterate() as Iterable<{ article_id: string; url: string; label: string | null }>) {
    let list = map.get(row.article_id);
    if (!list) map.set(row.article_id, (list = []));
    list.push({ url: row.url, label: row.label });
  }
  return map;
}

// ── policy: --user-map ──────────────────────────────────────────────────────

function createPolicy(userMap: ReadonlyMap<string, string>) {
  const unmapped = new Map<string, number>();
  let boms = 0;
  return {
    apply(spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
      let out = row;
      // A leading U+FEFF in a text value (one feishu link label has it) does not survive
      // PGlite's decoder, so the read-back could never verify; strip it on the way in and say so.
      for (const c of spec.columns) {
        const v = out[c.name];
        if (c.kind === "text" && typeof v === "string" && v.startsWith("\uFEFF")) {
          if (out === row) out = { ...row };
          out[c.name] = v.replace(/^\uFEFF+/, "");
          boms += 1;
        }
      }
      if (spec.name !== "ai_usage" || out.user_id === null) return out;
      const old = String(out.user_id as string);
      const mapped = userMap.get(old);
      if (mapped !== undefined) return { ...out, user_id: mapped };
      unmapped.set(old, (unmapped.get(old) ?? 0) + 1);
      return { ...out, user_id: null };
    },
    notes(): string[] {
      const notes = [...unmapped].map(
        ([id, n]) =>
          `ai_usage: ${n} row${n === 1 ? " had" : "s had"} an unmapped user_id (${id}) -> NULL`,
      );
      if (boms > 0)
        notes.push(
          `${boms} text value${boms === 1 ? "" : "s"} had a leading U+FEFF (BOM) stripped`,
        );
      return notes;
    },
  };
}

// ── derive ──────────────────────────────────────────────────────────────────

interface DeriveContext {
  readonly links: ReadonlyMap<string, RenderLink[]>;
  readonly targets: LinkTargetIndex & {
    readonly byCanonicalUrl: Map<string, string>;
    readonly bySourceArticleId: Map<string, string>;
  };
  readonly counters: { derived: number };
}

/** Adds the derived Postgres columns to the insert object (TS keys). */
function derive(
  table: string,
  src: Record<string, unknown>,
  out: Record<string, unknown>,
  ctx: DeriveContext,
): void {
  switch (table) {
    case "articles": {
      const id = String(src.id);
      ctx.targets.byCanonicalUrl.set(String(src.canonical_url), id);
      ctx.targets.bySourceArticleId.set(String(src.source_article_id), id);
      if (typeof src.content_raw === "string") {
        out.contentHtml = renderArticleHtml({
          format: src.content_format === "markdown" ? "markdown" : "html",
          raw: src.content_raw,
          baseUrl: String(src.canonical_url),
          title: String(src.title),
          links: ctx.links.get(id) ?? [],
        });
        ctx.counters.derived += 1;
      } else {
        out.contentHtml = null;
      }
      break;
    }
    case "article_links": {
      const target = resolveLinkTarget(ctx.targets, String(src.url));
      out.targetArticleId = target;
      if (target) ctx.counters.derived += 1;
      break;
    }
    case "article_search":
      out.document = buildDocument(ARTICLE_SEARCH_FIELDS.map((f) => text(src[f])));
      ctx.counters.derived += 1;
      break;
    case "kb_search":
      out.document = buildDocument(KB_SEARCH_FIELDS.map((f) => text(src[f])));
      ctx.counters.derived += 1;
      break;
  }
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── Postgres side ───────────────────────────────────────────────────────────

/** db column name -> drizzle TS key, per table. */
function keyByDbName(table: PgTable): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [key, column] of Object.entries(getTableColumns(table))) map.set(column.name, key);
  return map;
}

async function readBack(tx: BbsDb, spec: TableSpec): Promise<{ rows: number; checksum: string }> {
  const table = TARGETS[spec.name as keyof typeof TARGETS];
  const columns = getTableColumns(table);
  const byDb = new Map(Object.values(columns).map((c) => [c.name, c]));
  const pick = Object.fromEntries(spec.columns.map((c) => [c.name, byDb.get(c.name)!]));
  const rows = (await tx.select(pick).from(table)) as Record<string, unknown>[];
  const digest = new TableDigest();
  for (const row of rows) digest.add(canonicalRow(spec, row));
  return { rows: digest.rows, checksum: digest.digest() };
}

function sameCorpus(previous: readonly Digest[], current: readonly Digest[]): boolean {
  if (previous.length !== current.length) return false;
  const byTable = new Map(previous.map((d) => [d.table, d]));
  return current.every((d) => {
    const p = byTable.get(d.table);
    return p !== undefined && p.rows === d.rows && p.checksum === d.checksum;
  });
}

async function lastOkRun(db: BbsDb): Promise<{
  id: string;
  tables: Digest[];
  renderVersion: string;
  normalizeVersion: string;
} | null> {
  const rows = await db
    .select({
      id: importRuns.id,
      tables: importRuns.tables,
      renderVersion: importRuns.renderVersion,
      normalizeVersion: importRuns.normalizeVersion,
    })
    .from(importRuns)
    .where(sql`${importRuns.ok} and not ${importRuns.noop}`)
    .orderBy(sql`${importRuns.startedAt} desc`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const tables = Array.isArray(row.tables) ? (row.tables as Digest[]) : [];
  return {
    id: row.id,
    tables,
    renderVersion: row.renderVersion,
    normalizeVersion: row.normalizeVersion,
  };
}

async function recordRun(
  db: BbsDb,
  run: {
    id: string;
    startedAt: Date;
    sourcePath: string;
    sourceBytes: number;
    ok: boolean;
    noop: boolean;
    tables: readonly TableReport[];
    notes: readonly string[];
  },
): Promise<void> {
  await db.insert(importRuns).values({
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: new Date(),
    sourcePath: run.sourcePath,
    sourceBytes: run.sourceBytes,
    ok: run.ok,
    noop: run.noop,
    tables: run.tables as unknown as Record<string, unknown>[],
    notes: [...run.notes],
    renderVersion: RENDER_VERSION,
    normalizeVersion: NORMALIZE_VERSION,
  });
}

/** RFC 9562 UUIDv7: 48-bit ms timestamp, version nibble, 74 random bits. Sorts by time. */
export function uuidv7(at: Date): string {
  const ms = BigInt(at.getTime());
  const bytes = randomBytes(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
