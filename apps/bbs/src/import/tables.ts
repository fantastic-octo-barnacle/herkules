/**
 * What is read out of `app.db`, in foreign-key order, and what is refused.
 * Ported from herkules-old's `TABLES` with the edits the dropped tables force.
 */
import { DatabaseSync } from "node:sqlite";

import type { Column, Kind } from "./convert.ts";

export interface TableSpec {
  readonly name: string;
  /** SOURCE columns only; derived Postgres columns are added by derive.ts and excluded from digests. */
  readonly columns: readonly Column[];
  /** Custom SQLite SELECT when the target column is not a plain source column. */
  readonly source?: string;
  /** Diagnostic counts run against the SOURCE before loading; surfaced in the report. */
  readonly audits?: readonly { readonly note: string; readonly sql: string }[];
}

const col = (name: string, kind: Kind = "text"): Column => ({ name, kind });
const ms = (name: string): Column => col(name, "ms");
const int = (name: string): Column => col(name, "int");

const KB_SEARCH_COLUMNS = [
  "tldr",
  "problem",
  "approach",
  "components",
  "parameters",
  "decisions",
  "pitfalls",
  "entities",
  "keywords",
  "captions",
] as const;

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
 *  - ai_usage: plain `SELECT user_id …`; the mapping is TypeScript policy (parseUserMap). A dangling
 *    `article_id` (written with foreign keys off) is nulled in SQL, as herkules-old did, and audited.
 */
export const TABLES: readonly TableSpec[] = [
  {
    name: "sources",
    columns: [
      col("id"),
      col("kind"),
      col("name"),
      col("site_url"),
      col("enabled", "bool"),
      int("backfill_next_page"),
      ms("backfill_completed_at"),
      ms("initialized_at"),
      ms("last_checked_at"),
      ms("created_at"),
      ms("updated_at"),
    ],
  },
  {
    name: "articles",
    columns: [
      col("id"),
      col("source_id"),
      col("source_article_id"),
      col("canonical_url"),
      col("url_hash"),
      col("title"),
      col("author"),
      ms("published_at"),
      ms("discovered_at"),
      ms("fetched_at"),
      int("listing_position"),
      col("is_pinned", "bool"),
      col("introduction"),
      col("content_format"),
      col("content_raw"),
      col("body_text"),
      col("content_hash"),
      col("parser_version"),
      col("status"),
      col("skip_reason"),
      col("last_error"),
      ms("created_at"),
      ms("updated_at"),
      ms("refresh_requested_at"),
      ms("content_changed_at"),
      col("title_season"),
      col("title_team"),
      col("title_topic"),
      col("title_labels", "textarray"),
    ],
  },
  {
    name: "article_tags",
    columns: [col("article_id"), col("tag"), int("position")],
    source:
      "SELECT article_id, tag, ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY rowid) - 1 AS position FROM article_tags",
  },
  {
    name: "article_links",
    columns: [col("id"), col("article_id"), col("url"), col("kind"), col("label"), int("position")],
  },
  {
    name: "article_images",
    columns: [
      col("id"),
      col("article_id"),
      col("url"),
      col("alt"),
      int("position"),
      col("caption"),
      col("image_kind"),
      col("image_text"),
    ],
  },
  {
    name: "poll_runs",
    columns: [
      col("id"),
      col("source_id"),
      col("trigger"),
      col("status"),
      ms("started_at"),
      ms("finished_at"),
      int("listed"),
      int("discovered"),
      int("fetched"),
      int("skipped"),
      int("failed"),
      col("error"),
      int("refreshed"),
    ],
  },
  {
    name: "source_guard_state",
    columns: [col("source_id"), col("state_json", "json"), ms("updated_at")],
  },
  {
    // context_text deliberately not ported (schema.ts header).
    name: "article_ai",
    columns: [
      col("article_id"),
      col("status"),
      col("prompt_version"),
      col("model"),
      col("context_hash"),
      col("overview_json", "json"),
      col("kb_json", "json"),
      col("images_json", "json"),
      int("attempts"),
      col("error"),
      int("prompt_tokens"),
      int("cached_tokens"),
      int("completion_tokens"),
      col("cost_usd", "double"),
      ms("generated_at"),
      ms("updated_at"),
    ],
  },
  {
    name: "kb_entities",
    columns: [col("key"), col("name"), int("article_count"), ms("updated_at")],
  },
  {
    name: "article_entities",
    columns: [col("article_id"), col("entity_key")],
  },
  {
    name: "ai_usage",
    columns: [
      col("id"),
      col("user_id"),
      col("article_id"),
      col("kind"),
      col("model"),
      int("prompt_tokens"),
      int("cached_tokens"),
      int("completion_tokens"),
      col("cost_usd", "double"),
      ms("created_at"),
    ],
    source:
      "SELECT id, user_id, CASE WHEN article_id IN (SELECT id FROM articles) THEN article_id END AS article_id, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at FROM ai_usage",
    audits: [
      {
        note: "ai_usage: rows whose article no longer exists (article_id -> NULL)",
        sql: "SELECT COUNT(*) AS n FROM ai_usage WHERE article_id IS NOT NULL AND article_id NOT IN (SELECT id FROM articles)",
      },
    ],
  },
  {
    // FTS5 tables answer plain SELECTs; the Rust writer stored '' for missing fields, so NULL
    // cannot appear, but the targets are NOT NULL either way.
    name: "article_search",
    columns: [
      col("article_id"),
      col("title"),
      col("author"),
      col("tags"),
      col("introduction"),
      col("body_text"),
    ],
    source:
      "SELECT article_id, COALESCE(title, '') AS title, COALESCE(author, '') AS author, COALESCE(tags, '') AS tags, COALESCE(introduction, '') AS introduction, COALESCE(body_text, '') AS body_text FROM article_search",
  },
  {
    name: "kb_search",
    columns: [col("article_id"), ...KB_SEARCH_COLUMNS.map((c) => col(c))],
    source: `SELECT article_id, ${KB_SEARCH_COLUMNS.map((c) => `COALESCE(${c}, '') AS ${c}`).join(", ")} FROM kb_search`,
  },
];

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

export class SourceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSchemaError";
  }
}

/**
 * Refuses a source that is not the schema we know: requires exactly versions 1..6
 * present and successful in `_sqlx_migrations`, and rejects any table not in
 * TABLES ∪ SKIPPED ∪ {_sqlx_migrations} unless it matches the FTS5 shadow-table
 * pattern `^(article_search|kb_search)_(config|content|data|docsize|idx)$`.
 * Never reads the migration `checksum` column — rm-wenku's stale sqlx checksum is irrelevant here.
 * Throws SourceSchemaError; returns what it saw otherwise.
 */
export function checkSource(sqlitePath: string): { versions: number[]; strangers: string[] } {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return checkOpenSource(sqlite);
  } finally {
    sqlite.close();
  }
}

export function checkOpenSource(sqlite: DatabaseSync): { versions: number[]; strangers: string[] } {
  let rows: { version: number | bigint; success: number | bigint }[];
  try {
    rows = sqlite
      .prepare("SELECT version, success FROM _sqlx_migrations ORDER BY version")
      .all() as { version: number | bigint; success: number | bigint }[];
  } catch {
    throw new SourceSchemaError("not an rm-wenku database: no _sqlx_migrations table");
  }
  const versions = rows.filter((r) => Number(r.success) !== 0).map((r) => Number(r.version));
  if (JSON.stringify(versions) !== JSON.stringify([...EXPECTED_SQLITE_VERSIONS])) {
    throw new SourceSchemaError(
      `expected SQLite migrations ${EXPECTED_SQLITE_VERSIONS.join(",")} applied, found ${versions.join(",") || "none"}`,
    );
  }
  const known = new Set([
    ...TABLES.map((t) => t.name),
    ...Object.keys(SKIPPED),
    "_sqlx_migrations",
  ]);
  const names = (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const strangers = names.filter(
    (name) =>
      !known.has(name) &&
      !/^(article_search|kb_search)_(config|content|data|docsize|idx)$/.test(name),
  );
  if (strangers.length > 0) {
    throw new SourceSchemaError(`unknown source tables: ${strangers.join(", ")}`);
  }
  return { versions, strangers };
}

/**
 * `--user-map <old_id>=<sub>`, repeatable. Policy for `ai_usage.user_id`:
 *   null stays null (105 of 106 rows); a mapped old id becomes the issuer `sub`;
 *   an UNMAPPED non-null id becomes null and is counted in a report note.
 * Today nearly a no-op (the snapshot's one non-null `user_id` is a test id with no user);
 * it exists because the old box keeps generating usage, and "silently nulled N rows" must be
 * a line in the report rather than a discovery. Throws on a malformed pair.
 */
export function parseUserMap(pairs: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const from = eq < 0 ? "" : pair.slice(0, eq).trim();
    const to = eq < 0 ? "" : pair.slice(eq + 1).trim();
    if (!from || !to)
      throw new TypeError(`--user-map: expected <old_id>=<sub>, got ${JSON.stringify(pair)}`);
    map.set(from, to);
  }
  return map;
}
