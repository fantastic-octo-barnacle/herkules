/**
 * The knowledge base: browse with cross-filtered facets, entity list, entity
 * detail, entity head. All of it reads `article_ai.overview_json` / `kb_json`,
 * `jsonb` here and TEXT-with-json_extract in SQLite:
 *
 *   json_extract(ai.overview_json, '$.tldr')                     -> overview_json ->> 'tldr'
 *   EXISTS (SELECT 1 FROM json_each(kb_json,'$.domain') WHERE value = ?)
 *                                                                -> jsonb_exists(kb_json -> 'domain', :v)
 *   json_valid(ai.kb_json) guard                                 -> gone: jsonb cannot be invalid
 *
 * `jsonb_exists(a, b)` is the `?` operator spelled as a function. `?` is not a
 * placeholder in postgres.js, PGlite or drizzle (all emit `$n`), so the function
 * form is a readability choice, not a driver workaround.
 */
import type { LibraryDeps } from "./index.ts";
import type {
  EntityCount,
  EntityDetail,
  EntityKey,
  HeadMeta,
  KbBrowse,
  KbFilter,
} from "./types.ts";

/**
 * TWO queries.
 *
 * (1) cards + total:
 *   SELECT ai.article_id, a.title, a.author, a.published_at,
 *          coalesce(ai.overview_json ->> 'tldr', '') AS tldr, coalesce(ai.overview_json ->> 'genre', '') AS genre,
 *          coalesce(ai.overview_json #>> '{maturity,status}', '') AS maturity, ai.kb_json ->> 'problem' AS problem,
 *          coalesce(ai.kb_json -> 'domain', '[]'::jsonb) AS domain, … robotTypes, entities, pitfalls …,
 *          count(*) OVER () AS total                                -- of the FILTERED set, before LIMIT
 *   FROM article_ai ai JOIN articles a ON a.id = ai.article_id
 *   WHERE ai.status = 'ready' AND a.status = 'fetched'
 *     [AND jsonb_exists(ai.kb_json -> 'domain', :domain)] [AND jsonb_exists(ai.kb_json -> 'robotTypes', :robot)]
 *     [AND ai.overview_json ->> 'genre' = :genre]
 *     [AND EXISTS (SELECT 1 FROM kb_search s WHERE s.article_id = a.id AND <search.match(KB_COLUMNS, terms)>)]  -- q
 *   ORDER BY coalesce(a.published_at, a.discovered_at) DESC LIMIT :limit;
 *
 * (2) all three facet axes, one statement. A facet never narrows itself: each axis is counted
 * under the OTHER filters (and `q`), so every chip stays clickable.
 *   WITH ready AS (SELECT ai.kb_json, ai.overview_json ->> 'genre' AS genre, a.id FROM … WHERE ready ∧ fetched [∧ q])
 *   SELECT 'domain' AS axis, v AS name, count(*) FROM ready, jsonb_array_elements_text(kb_json -> 'domain') v
 *     WHERE [robot] AND [genre] GROUP BY v
 *   UNION ALL SELECT 'robot', v, count(*) FROM ready, jsonb_array_elements_text(kb_json -> 'robotTypes') v
 *     WHERE [domain] AND [genre] GROUP BY v
 *   UNION ALL SELECT 'genre', genre, count(*) FROM ready WHERE genre <> '' AND [domain] AND [robot] GROUP BY genre
 *   ORDER BY count DESC, name ASC;
 * `jsonb_array_elements_text` in a comma-join is an implicit LATERAL and yields zero rows for a
 * NULL or non-array — the reason rm-wenku's `json_valid()` guard has no counterpart. TypeScript
 * pivots the three axes out of one result set. Two statements because the cards are LIMITed and
 * the facets are not. It was five.
 */
export function kbBrowse(deps: LibraryDeps, filter: KbFilter): Promise<KbBrowse> {
  void deps;
  void filter;
  // TODO jsonb arrays parsed with non-strings dropped, as rm-wenku did (ai.rs:190-200)
  throw new Error("not implemented");
}

/**
 * ONE query: `SELECT key, name, article_count FROM kb_entities WHERE article_count > 0
 * [AND name ILIKE '%' || :q || '%'] ORDER BY article_count DESC, name ASC LIMIT :limit`.
 * 788 entities exist but only 688 links: regeneration orphans entities and recomputes the
 * counter without deleting the row, so `article_count > 0` is the definition of "exists".
 * (`ILIKE` here is the one place SQL lower-cases; entity names are the model's ASCII/CJK
 * strings and a 788-row scan needs no index.)
 */
export function listEntities(
  deps: LibraryDeps,
  options: { readonly q?: string; readonly limit: number },
): Promise<readonly EntityCount[]> {
  void deps;
  void options;
  throw new Error("not implemented");
}

/**
 * ONE query — the N+1 that mattered most (rm-wenku ran a five-query article fetch, render
 * included, per matching article, then threw the HTML away):
 *   SELECT e.key, e.name, e.article_count, a.id, a.title, a.author, a.published_at,
 *          coalesce(ai.overview_json ->> 'tldr', '') AS tldr, ai.kb_json
 *   FROM kb_entities e
 *   LEFT JOIN article_entities ae ON ae.entity_key = e.key
 *   LEFT JOIN articles a ON a.id = ae.article_id AND a.status = 'fetched'
 *   LEFT JOIN article_ai ai ON ai.article_id = a.id AND ai.status = 'ready'
 *   WHERE e.key = :key
 *   ORDER BY coalesce(a.published_at, a.discovered_at) DESC NULLS LAST, a.id DESC;
 * LEFT JOINs so an entity with zero live articles still returns its header; the ORDER BY is
 * at statement level, not inside an `IN (…)` where rm-wenku put it and where it guaranteed nothing.
 */
export function getEntity(deps: LibraryDeps, key: EntityKey): Promise<EntityDetail | null> {
  void deps;
  void key;
  throw new Error("not implemented");
}

/** ONE query, two columns: `SELECT name, article_count FROM kb_entities WHERE key = :key AND article_count > 0`. */
export function getEntityHead(deps: LibraryDeps, key: EntityKey): Promise<HeadMeta | null> {
  void deps;
  void key;
  throw new Error("not implemented");
}
