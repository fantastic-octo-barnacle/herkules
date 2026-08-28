/**
 * `/tags` — the whole vocabulary on one page, which the old SPA only ever showed
 * as tabs above the feed. Every chip is a typed link back into the feed's filters.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { usePageTitle } from "../shell/usePageTitle.ts";
import { tagsRoute } from "../routes.tsx";
import { groupOf, leafOf } from "../url.ts";
import "./tags.css";

export function TagsPage() {
  usePageTitle("标签");
  const { q } = tagsRoute.useRouteContext();
  const { data: tags } = useSuspenseQuery(q.tags());

  // One pass over `items` keyed by group, so a tag whose group has no row of its
  // own (possible: groups are counted with COUNT(DISTINCT article)) is not dropped.
  const byGroup = new Map<string, { name: string; count: number }[]>();
  for (const item of tags.items) {
    const group = groupOf(item.name);
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(item);
    else byGroup.set(group, [item]);
  }
  const groups = tags.groups.filter((group) => byGroup.has(group.name));

  return (
    <div className="page">
      <h1 className="page-title">标签</h1>
      <p className="lede">
        共 {tags.total} 篇文章、{tags.items.length}{" "}
        个标签。群组的篇数按文章去重，因此不等于其下标签之和。
      </p>
      {groups.map((group) => (
        <section className="tags-group" key={group.name}>
          <div className="tags-head">
            <h2>
              <Link to="/" search={{ scope: "all", group: group.name }}>
                {group.name}
              </Link>
            </h2>
            <span className="meta">{group.count} 篇</span>
          </div>
          <div className="tags-chips">
            {(byGroup.get(group.name) ?? []).map((tag) => (
              <Link className="chip" key={tag.name} to="/" search={{ scope: "all", tag: tag.name }}>
                {leafOf(tag.name)}
                <span className="meta">{tag.count}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 ? <p className="empty">还没有标签。</p> : null}
    </div>
  );
}
