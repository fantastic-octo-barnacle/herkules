/**
 * What is read out of `app.db`, in foreign-key order, and what is refused.
 * Ported from herkules-old's `TABLES` with the edits the dropped tables force.
 */
import type { Column } from "./convert.ts";

export interface TableSpec {
  readonly name: string;
  /** SOURCE columns only; derived Postgres columns are added by derive.ts and excluded from digests. */
  readonly columns: readonly Column[];
  /** Custom SQLite SELECT when the target column is not a plain source column. */
  readonly source?: string;
  /** Diagnostic counts run against the SOURCE before loading; surfaced in the report. */
  readonly audits?: readonly { readonly note: string; readonly sql: string }[];
}

/**
 * FK order, thirteen specs: sources, articles, article_tags, article_links, article_images,
 * poll_runs, source_guard_state, article_ai (WITHOUT context_text), kb_entities,
 * article_entities, ai_usage, article_search, kb_search. `import_runs` is history, not cargo.
 *
 * Custom `source` SQL:
 *  - article_tags: `ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY rowid) - 1 AS position`
 *    — Postgres has no rowid, and the source's tag order is what the eyebrow chips render.
 *  - article_search / kb_search: `SELECT article_id, COALESCE(title,'') AS title, … FROM article_search`
 *    — read from the FTS5 VIRTUAL TABLE directly (node:sqlite reads it); FTS5 columns are nullable,
 *    the targets are NOT NULL. `document` is not read from SQLite at all (derive.ts).
 *  - ai_usage: plain `SELECT user_id …`; the mapping is TypeScript policy (parseUserMap).
 */
export const TABLES: readonly TableSpec[] = [];

/**
 * Counted and reported, never loaded. `checkSource` derives its "no stranger tables"
 * allowlist from TABLES ∪ SKIPPED, so a table merely deleted from TABLES makes the real
 * `app.db` fail with `unknown source tables: users` — the trap herkules-old's shape sets.
 */
export const SKIPPED: Readonly<Record<string, string>> = {
  users: "identity is the herkules issuer's; ai_usage.user_id is mapped with --user-map",
  sessions: "apps/bbs has no session table (sealed cookie via @herkules/oauth-client)",
  api_tokens: "PATs are out of scope; agents authenticate with issuer-minted JWTs",
};

/** rm-wenku's sqlx migration versions this importer understands. */
export const EXPECTED_SQLITE_VERSIONS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Refuses a source that is not the schema we know: requires exactly versions 1..6
 * present and successful in `_sqlx_migrations`, and rejects any table not in
 * TABLES ∪ SKIPPED ∪ {_sqlx_migrations} unless it matches the FTS5 shadow-table
 * pattern `^(article_search|kb_search)_(config|content|data|docsize|idx)$`.
 * Never reads the migration `checksum` column — rm-wenku's stale sqlx checksum is irrelevant here.
 */
export function checkSource(sqlitePath: string): { versions: number[]; strangers: string[] } {
  void sqlitePath;
  throw new Error("not implemented");
}

/**
 * `--user-map <old_id>=<sub>`, repeatable. Policy for `ai_usage.user_id`:
 *   null stays null (105 of 106 rows); a mapped old id becomes the issuer `sub`;
 *   an UNMAPPED non-null id becomes null and is counted in a report note.
 * Today nearly a no-op (the snapshot's one non-null `user_id` is a test id with no user);
 * it exists because the old box keeps generating usage, and "silently nulled N rows" must be
 * a line in the report rather than a discovery.
 */
export function parseUserMap(pairs: readonly string[]): ReadonlyMap<string, string> {
  void pairs;
  throw new Error("not implemented");
}
