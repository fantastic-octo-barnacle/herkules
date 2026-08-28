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
 * form is a readability choice, not a driver workaround. `jsonb_array_elements_text`
 * errors on a scalar, so array-valued keys go through `arr()`, which yields `[]`
 * for anything that is not an array.
 */
import type { SQL } from "drizzle-orm";
import { and, sql } from "drizzle-orm";

import { rowsOf } from "../db/index.ts";
import { articleAi, articleEntities, articles, kbEntities } from "../db/schema.ts";
import { parseKbEntry } from "./ai-json.ts";
import { AI_JOIN, FETCHED, date, num, str, strings } from "./articles.ts";
import { FEED_AT } from "./cursor.ts";
import type { LibraryDeps } from "./index.ts";
import { feedMatch } from "./search.ts";
import type {
  ArticleId,
  EntityCount,
  EntityDetail,
  EntityKey,
  HeadMeta,
  KbBrowse,
  KbCard,
  KbFilter,
  TagCount,
} from "./types.ts";

/** `kb_json -> :key` when it is an array, else `'[]'`. */
function arr(key: string): SQL {
  const v = sql`${articleAi.kbJson} -> ${key}`;
  return sql`(CASE WHEN jsonb_typeof(${v}) = 'array' THEN ${v} ELSE '[]'::jsonb END)`;
}

const GENRE: SQL = sql`${articleAi.overviewJson} ->> 'genre'`;

function facetFilters(filter: { domain?: string; robot?: string; genre?: string }): SQL[] {
  const out: SQL[] = [];
  if (filter.domain) out.push(sql`jsonb_exists(${arr("domain")}, ${filter.domain})`);
  if (filter.robot) out.push(sql`jsonb_exists(${arr("robotTypes")}, ${filter.robot})`);
  if (filter.genre) out.push(sql`${GENRE} = ${filter.genre}`);
  return out;
}

/**
 * TWO queries.
 *
 * (1) cards + total:
 *   SELECT article_ai.article_id, articles.title, articles.author, articles.published_at,
 *          coalesce(overview_json ->> 'tldr', '') AS tldr, coalesce(overview_json ->> 'genre', '') AS genre,
 *          coalesce(overview_json #>> '{maturity,status}', '') AS maturity, kb_json ->> 'problem' AS problem,
 *          kb_json -> 'domain', … robotTypes, entities, pitfalls …,
 *          count(*) OVER () AS total                                -- of the FILTERED set, before LIMIT
 *   FROM article_ai JOIN articles ON articles.id = article_ai.article_id
 *   WHERE article_ai.status = 'ready' AND articles.status = 'fetched'
 *     [AND jsonb_exists(kb_json -> 'domain', :domain)] [AND jsonb_exists(kb_json -> 'robotTypes', :robot)]
 *     [AND overview_json ->> 'genre' = :genre]
 *     [AND EXISTS (SELECT 1 FROM kb_search WHERE article_id = articles.id AND <search.match(KB_COLUMNS, terms)>)]  -- q
 *   ORDER BY coalesce(published_at, discovered_at) DESC, articles.id DESC LIMIT :limit;
 *
 * (2) all three facet axes, one statement. A facet never narrows itself: each axis is counted
 * under the OTHER filters (and `q`), so every chip stays clickable.
 *   WITH ready AS (SELECT kb_json, overview_json ->> 'genre' AS genre FROM … WHERE ready ∧ fetched [∧ q])
 *   SELECT 'domain' AS axis, v AS name, count(*) FROM ready, jsonb_array_elements_text(kb_json -> 'domain') v
 *     WHERE [robot] AND [genre] GROUP BY v
 *   UNION ALL SELECT 'robot', v, count(*) FROM ready, jsonb_array_elements_text(kb_json -> 'robotTypes') v
 *     WHERE [domain] AND [genre] GROUP BY v
 *   UNION ALL SELECT 'genre', genre, count(*) FROM ready WHERE genre <> '' AND [domain] AND [robot] GROUP BY genre
 *   ORDER BY count DESC, name ASC;
 * TypeScript pivots the three axes out of one result set. Two statements because the cards are
 * LIMITed and the facets are not. It was five.
 */
export async function kbBrowse(deps: LibraryDeps, filter: KbFilter): Promise<KbBrowse> {
  const base: SQL[] = [sql`${articleAi.status} = 'ready'`, FETCHED];
  if (filter.q?.trim()) base.push(feedMatch(deps, "kb", filter.q));
  const limit = Math.max(1, filter.limit);

  const cards = rowsOf(
    await deps.db.execute(sql`
      SELECT ${articleAi.articleId} AS article_id, ${articles.title} AS title, ${articles.author} AS author,
        ${articles.publishedAt} AS published_at,
        coalesce(${articleAi.overviewJson} ->> 'tldr', '') AS tldr, coalesce(${GENRE}, '') AS genre,
        coalesce(${articleAi.overviewJson} #>> '{maturity,status}', '') AS maturity,
        ${articleAi.kbJson} ->> 'problem' AS problem,
        ${arr("domain")} AS domain, ${arr("robotTypes")} AS robot_types, ${arr("entities")} AS entities,
        ${arr("pitfalls")} AS pitfalls,
        count(*) OVER ()::int AS total
      FROM ${articleAi} JOIN ${articles} ON ${articles.id} = ${articleAi.articleId}
      WHERE ${and(...base, ...facetFilters(filter))}
      ORDER BY ${FEED_AT} DESC, ${articles.id} DESC
      LIMIT ${sql.raw(String(limit))}`),
  );

  const readyWhere = and(...base);
  const axis = (name: string, key: "domain" | "robotTypes", others: SQL[]) =>
    sql`SELECT ${name} AS axis, v AS name, count(*)::int AS count
        FROM ${articleAi} JOIN ${articles} ON ${articles.id} = ${articleAi.articleId}, jsonb_array_elements_text(${arr(key)}) v
        WHERE ${and(readyWhere, ...others)} GROUP BY v`;
  const facets = rowsOf(
    await deps.db.execute(sql`
      ${axis("domain", "domain", facetFilters({ robot: filter.robot, genre: filter.genre }))}
      UNION ALL
      ${axis("robot", "robotTypes", facetFilters({ domain: filter.domain, genre: filter.genre }))}
      UNION ALL
      SELECT 'genre' AS axis, ${GENRE} AS name, count(*)::int AS count
        FROM ${articleAi} JOIN ${articles} ON ${articles.id} = ${articleAi.articleId}
        WHERE ${and(readyWhere, sql`coalesce(${GENRE}, '') <> ''`, ...facetFilters({ domain: filter.domain, robot: filter.robot }))}
        GROUP BY ${GENRE}
      ORDER BY 3 DESC, 2 ASC`),
  );
  const pick = (name: string): TagCount[] =>
    byCount(
      facets
        .filter((r) => r.axis === name)
        .map((r) => ({ name: String(r.name), count: num(r.count) })),
    );

  return {
    total: num(cards[0]?.total),
    domains: pick("domain"),
    robotTypes: pick("robot"),
    genres: pick("genre"),
    cards: cards.map(cardOf),
  };
}

/** count DESC, then name by code point — the same tie order on every host, whatever the database collation. */
export function byCount(items: TagCount[]): TagCount[] {
  return items.sort(
    (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

function cardOf(r: Record<string, unknown>): KbCard {
  return {
    articleId: String(r.article_id) as ArticleId,
    title: String(r.title),
    author: str(r.author),
    publishedAt: date(r.published_at),
    tldr: str(r.tldr) ?? "",
    genre: str(r.genre) ?? "",
    maturity: str(r.maturity) ?? "",
    problem: str(r.problem),
    domain: strings(r.domain),
    robotTypes: strings(r.robot_types),
    entities: strings(r.entities),
    pitfalls: strings(r.pitfalls),
  };
}

/**
 * ONE query: `SELECT key, name, article_count FROM kb_entities WHERE article_count > 0
 * [AND name ILIKE '%' || :q || '%'] ORDER BY article_count DESC, name ASC LIMIT :limit`.
 * 788 entities exist but only 688 links: regeneration orphans entities and recomputes the
 * counter without deleting the row, so `article_count > 0` is the definition of "exists".
 * (`ILIKE` here is the one place SQL lower-cases; entity names are the model's ASCII/CJK
 * strings and a 788-row scan needs no index.)
 */
export async function listEntities(
  deps: LibraryDeps,
  options: { readonly q?: string; readonly limit: number },
): Promise<readonly EntityCount[]> {
  const conds: SQL[] = [sql`${kbEntities.articleCount} > 0`];
  const q = options.q?.trim();
  if (q)
    conds.push(
      sql`${kbEntities.name} ILIKE ${`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} ESCAPE '\\'`,
    );
  const rows = await deps.db
    .select({ key: kbEntities.key, name: kbEntities.name, articleCount: kbEntities.articleCount })
    .from(kbEntities)
    .where(and(...conds))
    .orderBy(sql`${kbEntities.articleCount} DESC`, kbEntities.name)
    .limit(Math.max(1, options.limit));
  return rows.map((r) => ({ key: r.key as EntityKey, name: r.name, articleCount: r.articleCount }));
}

/**
 * ONE query — the N+1 that mattered most (rm-wenku ran a five-query article fetch, render
 * included, per matching article, then threw the HTML away):
 *   SELECT e.key, e.name, e.article_count, articles.id, articles.title, articles.author, articles.published_at,
 *          coalesce(ai.overview_json ->> 'tldr', '') AS tldr, ai.kb_json
 *   FROM kb_entities e
 *   LEFT JOIN article_entities ae ON ae.entity_key = e.key
 *   LEFT JOIN articles ON articles.id = ae.article_id AND articles.status = 'fetched'
 *   LEFT JOIN article_ai ai ON ai.article_id = articles.id AND ai.status = 'ready'
 *   WHERE e.key = :key
 *   ORDER BY coalesce(published_at, discovered_at) DESC NULLS LAST, articles.id DESC;
 * LEFT JOINs so an entity with zero live articles still returns its header; the ORDER BY is
 * at statement level, not inside an `IN (…)` where rm-wenku put it and where it guaranteed nothing.
 */
export async function getEntity(deps: LibraryDeps, key: EntityKey): Promise<EntityDetail | null> {
  const rows = rowsOf(
    await deps.db.execute(sql`
      SELECT ${kbEntities.key} AS key, ${kbEntities.name} AS name, ${kbEntities.articleCount} AS article_count,
        ${articles.id} AS id, ${articles.title} AS title, ${articles.author} AS author,
        ${articles.publishedAt} AS published_at,
        coalesce(${articleAi.overviewJson} ->> 'tldr', '') AS tldr, ${articleAi.kbJson} AS kb
      FROM ${kbEntities}
      LEFT JOIN ${articleEntities} ON ${articleEntities.entityKey} = ${kbEntities.key}
      LEFT JOIN ${articles} ON ${articles.id} = ${articleEntities.articleId} AND ${FETCHED}
      ${AI_JOIN}
      WHERE ${kbEntities.key} = ${key}
      ORDER BY ${FEED_AT} DESC NULLS LAST, ${articles.id} DESC`),
  );
  const head = rows[0];
  if (!head) return null;
  return {
    entity: {
      key: String(head.key) as EntityKey,
      name: String(head.name),
      articleCount: num(head.article_count),
    },
    articles: rows
      .filter((r) => typeof r.id === "string")
      .map((r) => ({
        articleId: String(r.id) as ArticleId,
        title: String(r.title),
        author: str(r.author),
        publishedAt: date(r.published_at),
        tldr: str(r.tldr) ?? "",
        kb: parseKbEntry(r.kb) ?? EMPTY_KB,
      })),
  };
}

/** Every field at its default — what an article with no parseable kb blob shows as. */
const EMPTY_KB = parseKbEntry({})!;

/** ONE query, two columns: `SELECT name, article_count FROM kb_entities WHERE key = :key AND article_count > 0`. */
export async function getEntityHead(deps: LibraryDeps, key: EntityKey): Promise<HeadMeta | null> {
  const row = (
    await deps.db
      .select({ name: kbEntities.name, articleCount: kbEntities.articleCount })
      .from(kbEntities)
      .where(and(sql`${kbEntities.key} = ${key}`, sql`${kbEntities.articleCount} > 0`))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    title: row.name,
    description: `${row.name}：${row.articleCount} 篇相关文章`,
    path: `/kb/${encodeURIComponent(row.name)}`,
    type: "website",
    image: null,
    publishedAt: null,
    author: null,
  };
}
