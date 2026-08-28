/**
 * Tag and group counts. ONE query where rm-wenku used four.
 *
 *   WITH t AS (SELECT at.tag, at.group_name, at.article_id FROM article_tags at
 *              JOIN articles a ON a.id = at.article_id AND a.status = 'fetched')
 *   SELECT
 *     (SELECT jsonb_agg(x ORDER BY x.count DESC, x.name ASC) FROM
 *        (SELECT tag AS name, count(*) AS count FROM t GROUP BY tag) x)                    AS items,
 *     (SELECT jsonb_agg(y ORDER BY y.count DESC, y.name ASC) FROM
 *        (SELECT group_name AS name, count(DISTINCT article_id) AS count FROM t GROUP BY 1) y) AS groups,
 *     (SELECT count(*) FROM articles WHERE status = 'fetched')                             AS total;
 *
 * Two things that look like bugs and are not: groups use `count(DISTINCT article_id)`,
 * items do not (a group's count is NOT the sum of its tags'; the SPA's category tabs are
 * built around it); `group_name` is the generated column, so the `group/name` split has
 * one home (schema.ts) instead of rm-wenku's three.
 */
import type { LibraryDeps } from "./index.ts";
import type { TagIndex } from "./types.ts";

export function getTags(deps: LibraryDeps): Promise<TagIndex> {
  void deps;
  throw new Error("not implemented");
}
