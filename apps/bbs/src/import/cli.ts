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
export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export function runImportCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2> {
  void argv;
  void deps;
  // TODO parseArgs({ args: argv, allowPositionals: true, options: { "user-map": { type: "string", multiple: true },
  //        "dry-run": { type: "boolean" }, batch: { type: "string" } } })
  //      path = positionals[0] ?? (usage -> 2); userMap = parseUserMap(values["user-map"] ?? []) (malformed -> 2)
  //      config = loadConfig(deps.env)   // one config, one failure mode
  //      if (config.createDatabase) await ensureDatabase(config.databaseUrl)
  //      db = await createDb(config.databaseUrl); await migrate(db)
  //      try { report = await runImport({ db, sqlitePath: path, userMap, dryRun, batchSize }); printReport(report, out); return report.ok ? 0 : 1 }
  //      finally { await db.close() }
  throw new Error("not implemented");
}
