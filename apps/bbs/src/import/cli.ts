/**
 * `bbs import <app.db> [--user-map <old_id>=<sub>]… [--dry-run] [--batch N]`
 *
 * Reached as `docker compose run --rm bbs import /import/app.db` — the same
 * image serves and the entrypoint dispatches on argv (main.ts). Output (stdout)
 * is the operator's only feedback:
 *
 *   bbs import  source=/import/app.db (49.3 MB, sqlx 1..6)  target=…/bbs
 *     table                rows   checksum       status
 *     sources                 1   3f9c2a1b0d44   ok
 *     articles              969   a71e0c4d8b21   ok    (+905 content_html)
 *     article_tags         3030   0b17f9e5c8d0   ok
 *     article_links        3073   …              ok    (+1244 target_article_id)
 *     …
 *     article_search        905   …              ok    (+905 document)
 *     kb_search             105   …              ok    (+105 document)
 *     skipped: users(1) sessions(1) api_tokens(0)
 *     notes:   ai_usage: 1 row had an unmapped user_id (01TESTMEMBER…) -> NULL
 *   ok  13 tables, 13 574 rows, 2.9 s  (verified before commit; run 01J…)
 *
 * A re-run prints `no-op  digests and versions equal run 01J… (render 1, normalize 1)`.
 * Exit code is the contract: 0 ok (including no-op and dry-run), 1 verification
 * failed or source rejected, 2 usage error. Migrations are applied first,
 * unconditionally — a fresh box's first import must not depend on start-up order.
 */
import { statSync } from "node:fs";
import { parseArgs } from "node:util";

import { loadConfig } from "../config.ts";
import { createDb, ensureDatabase, migrate } from "../db/index.ts";
import type { ImportReport } from "./run.ts";
import { runImport } from "./run.ts";
import { EXPECTED_SQLITE_VERSIONS, SourceSchemaError, parseUserMap } from "./tables.ts";

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const USAGE = "usage: bbs import <app.db> [--user-map <old_id>=<sub>]... [--dry-run] [--batch N]";

export async function runImportCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2> {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    err(`bbs import: ${(e as Error).message}`);
    err(USAGE);
    return 2;
  }
  const path = parsed.positionals[0];
  if (!path || parsed.positionals.length > 1) {
    err(USAGE);
    return 2;
  }
  let userMap: ReadonlyMap<string, string>;
  let batchSize: number | undefined;
  try {
    userMap = parseUserMap(parsed.values["user-map"] ?? []);
    if (parsed.values.batch !== undefined) {
      batchSize = Number(parsed.values.batch);
      if (!Number.isInteger(batchSize) || batchSize <= 0)
        throw new TypeError("--batch: expected a positive integer");
    }
  } catch (e) {
    err(`bbs import: ${(e as Error).message}`);
    return 2;
  }
  let sourceBytes: number;
  try {
    sourceBytes = statSync(path).size;
  } catch {
    err(`bbs import: cannot read ${String(path)}`);
    return 2;
  }

  const config = loadConfig(deps.env); // one config, one failure mode
  out(
    `bbs import  source=${String(path)} (${(sourceBytes / 1_048_576).toFixed(1)} MB, sqlx ${String(EXPECTED_SQLITE_VERSIONS[0])}..${String(EXPECTED_SQLITE_VERSIONS.at(-1))})  target=${maskUrl(config.databaseUrl)}${parsed.values["dry-run"] ? "  (dry run)" : ""}`,
  );
  if (config.createDatabase) await ensureDatabase(config.databaseUrl);
  const db = await createDb(config.databaseUrl);
  try {
    await migrate(db);
    let report: ImportReport;
    try {
      report = await runImport({
        db,
        sqlitePath: path,
        userMap,
        dryRun: parsed.values["dry-run"] ?? false,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    } catch (e) {
      if (e instanceof SourceSchemaError) {
        err(`bbs import: source rejected: ${e.message}`);
        return 1;
      }
      throw e;
    }
    for (const line of formatReport(report, parsed.values["dry-run"] ?? false)) out(line);
    return report.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "user-map": { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      batch: { type: "string" },
    },
  });

/** The table printer. Pure; exported for the test. */
export function formatReport(report: ImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  if (report.noop) {
    lines.push(
      `no-op  digests and versions equal run ${report.previousRunId ?? "?"} (render ${report.renderVersion}, normalize ${report.normalizeVersion})`,
    );
    return lines;
  }
  lines.push(`  ${"table".padEnd(20)} ${"rows".padStart(6)}   ${"checksum".padEnd(12)}   status`);
  for (const t of report.tables) {
    const status = dryRun
      ? "hashed"
      : t.verified
        ? "ok"
        : report.error?.startsWith(`${t.table}:`)
          ? "MISMATCH"
          : "not verified";
    const derived = t.derived ? `    (${t.derived})` : "";
    lines.push(
      `  ${t.table.padEnd(20)} ${String(t.rows).padStart(6)}   ${t.checksum.slice(0, 12)}   ${status}${derived}`,
    );
  }
  lines.push(`  skipped: ${report.skipped.map((s) => `${s.table}(${s.rows})`).join(" ")}`);
  for (const note of report.notes) lines.push(`  notes:   ${note}`);
  const rows = report.tables.reduce((n, t) => n + t.rows, 0);
  const seconds = (report.durationMs / 1000).toFixed(1);
  if (dryRun) {
    lines.push(
      `ok  ${report.tables.length} tables, ${group(rows)} rows, ${seconds} s  (dry run; nothing written)`,
    );
  } else if (report.ok) {
    lines.push(
      `ok  ${report.tables.length} tables, ${group(rows)} rows, ${seconds} s  (verified before commit; run ${report.runId})`,
    );
  } else {
    lines.push(
      `FAILED  ${report.error ?? "verification failed"}; rolled back (run ${report.runId})`,
    );
  }
  return lines;
}

function group(n: number): string {
  return n.toLocaleString("en-US").replaceAll(",", " ");
}

/** `postgres://user:secret@host/db` -> `postgres://user:***@host/db`; pglite URLs pass through. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.href;
  } catch {
    return url;
  }
}
