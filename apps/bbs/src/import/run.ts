/**
 * `bbs import <app.db>` — the whole operation, in one function.
 *
 * It runs on the repo's DATABASE_URL pattern: herkules-old's migrator was
 * written against `pg` (`pool.connect()`, explicit BEGIN/COMMIT, `result.rows`);
 * this repo runs postgres.js in prod and PGlite in tests. Rewriting the four
 * driver-touching functions onto `db.transaction()` + `db.execute(sql…)` costs
 * ~80 lines and buys an import that runs end to end in CI with no Docker.
 *
 * ORDER:
 *   1. checkSource(sqlite)         refuse a schema we do not know; run each spec's audits
 *   2. DIGEST PASS                 stream every spec, hash rows -> SourceDigests. This IS --dry-run
 *                                  (no database touched; dry-run checksums equal live-run checksums).
 *   3. NO-OP CHECK                 last `ok` import_runs row: equal digests ∧ equal RENDER_VERSION ∧
 *                                  equal NORMALIZE_VERSION -> record a `noop: true` row, return, exit 0.
 *                                  No transaction is opened. This is done-predicate 1's wording.
 *   4. TRANSACTION                 TRUNCATE the thirteen IMPORTED_TABLES in one statement; per spec in
 *                                  FK order: stream batches of 500 from SQLite, convert(), add to the
 *                                  digest, derive (content_html, target_article_id, document), INSERT
 *                                  multi-row (articles: 30 columns × 500 = 15 000 params, under 65 535).
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
 */
import type { BbsDb } from "../db/index.ts";

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
}

/** Throws only on a broken source or an unusable database; a checksum mismatch returns `ok: false` after ROLLBACK. */
export function runImport(options: ImportOptions): Promise<ImportReport> {
  void options;
  throw new Error("not implemented");
}
