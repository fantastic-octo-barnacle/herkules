/**
 * Tag and group counts. ONE query where rm-wenku used four.
 *
 *   WITH t AS (SELECT at.tag, at.group_name, at.article_id FROM article_tags at
 *              JOIN articles ON articles.id = at.article_id AND articles.status = 'fetched')
 *   SELECT
 *     (SELECT coalesce(jsonb_agg(x ORDER BY x.count DESC, x.name ASC), '[]') FROM
 *        (SELECT tag AS name, count(*) AS count FROM t GROUP BY tag) x)                    AS items,
 *     (SELECT coalesce(jsonb_agg(y ORDER BY y.count DESC, y.name ASC), '[]') FROM
 *        (SELECT group_name AS name, count(DISTINCT article_id) AS count FROM t GROUP BY 1) y) AS groups,
 *     (SELECT count(*) FROM articles WHERE status = 'fetched')                             AS total;
 *
 * Two things that look like bugs and are not: groups use `count(DISTINCT article_id)`,
 * items do not (a group's count is NOT the sum of its tags'; the SPA's category tabs are
 * built around it); `group_name` is the generated column, so the `group/name` split has
 * one home (schema.ts) instead of rm-wenku's three.
 */
import { sql } from "drizzle-orm";

import { rowsOf } from "../db/index.ts";
import { articleTags, articles } from "../db/schema.ts";
import { FETCHED, json, num } from "./articles.ts";
import type { LibraryDeps } from "./index.ts";
import { byCount } from "./kb.ts";
import type { TagCount, TagIndex } from "./types.ts";

export async function getTags(deps: LibraryDeps): Promise<TagIndex> {
  const row = rowsOf(
    await deps.db.execute(sql`
      WITH t AS (
        SELECT ${articleTags.tag} AS tag, ${articleTags.groupName} AS group_name, ${articleTags.articleId} AS article_id
        FROM ${articleTags} JOIN ${articles} ON ${articles.id} = ${articleTags.articleId} AND ${FETCHED})
      SELECT
        (SELECT coalesce(jsonb_agg(x ORDER BY x.count DESC, x.name ASC), '[]'::jsonb)
           FROM (SELECT tag AS name, count(*)::int AS count FROM t GROUP BY tag) x) AS items,
        (SELECT coalesce(jsonb_agg(y ORDER BY y.count DESC, y.name ASC), '[]'::jsonb)
           FROM (SELECT group_name AS name, count(DISTINCT article_id)::int AS count FROM t GROUP BY 1) y) AS groups,
        (SELECT count(*)::int FROM ${articles} WHERE ${FETCHED}) AS total`),
  )[0];
  return {
    items: counts(row?.items),
    groups: counts(row?.groups),
    total: num(row?.total),
  };
}

function counts(v: unknown): TagCount[] {
  const parsed = json(v);
  if (!Array.isArray(parsed)) return [];
  return byCount(
    parsed.map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      return { name: typeof r.name === "string" ? r.name : "", count: num(r.count) };
    }),
  );
}
