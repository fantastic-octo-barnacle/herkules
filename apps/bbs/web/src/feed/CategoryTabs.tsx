import { Link } from "@tanstack/react-router";

import type { TagIndexDTO } from "../../../src/api/dto.ts";
import type { FeedSearch } from "../url.ts";
import { leafOf } from "../url.ts";
import { EXACT } from "./SearchBar.tsx";

/**
 * 群组 tabs with a sub-tag chip row. Counts come from `q.tags()`; a group's
 * count is COUNT(DISTINCT article), not the sum of its tags'. `q` and `scope`
 * ride along (the updater keeps them) so filtering never drops the query.
 */
export function CategoryTabs({ tags, search }: { tags: TagIndexDTO; search: FeedSearch }) {
  const { group, tag } = search;
  const subTags = group ? tags.items.filter((t) => t.name.startsWith(`${group}/`)) : [];

  return (
    <section className="feed-cats" aria-label="分类">
      <div className="feed-tabs">
        <Link
          className="feed-tab"
          to="/"
          activeOptions={EXACT}
          search={(s) => ({ ...s, group: undefined, tag: undefined })}
          aria-current={group === undefined ? "true" : undefined}
        >
          全部 <span className="feed-n">{tags.total}</span>
        </Link>
        {tags.groups.map((g) => (
          <Link
            key={g.name}
            className="feed-tab"
            to="/"
            activeOptions={EXACT}
            search={(s) => ({ ...s, group: g.name, tag: undefined })}
            aria-current={group === g.name ? "true" : undefined}
          >
            {g.name} <span className="feed-n">{g.count}</span>
          </Link>
        ))}
      </div>
      {group !== undefined && subTags.length > 0 && (
        <div className="feed-chips">
          <span className="eyebrow">{group} /</span>
          <Link
            className={tag === undefined ? "chip is-active" : "chip"}
            to="/"
            activeOptions={EXACT}
            search={(s) => ({ ...s, group, tag: undefined })}
            aria-current={tag === undefined ? "true" : undefined}
          >
            全部
          </Link>
          {subTags.map((t) => (
            <Link
              key={t.name}
              className={tag === t.name ? "chip is-active" : "chip"}
              to="/"
              activeOptions={EXACT}
              search={(s) => ({ ...s, group, tag: t.name })}
              aria-current={tag === t.name ? "true" : undefined}
              title={`${t.count} 篇`}
            >
              {leafOf(t.name)} <span className="feed-n">{t.count}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
