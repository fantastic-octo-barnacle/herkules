import { Link } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { feedRoute } from "../routes.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { ArticleRow } from "./ArticleRow.tsx";
import { CategoryTabs } from "./CategoryTabs.tsx";
import { LoadMore } from "./LoadMore.tsx";
import { ScopeLinks, SearchBar } from "./SearchBar.tsx";
import "./feed.css";

/** `/` — the date-ordered feed. The loader already ensured both queries; no pending or error branch. */
export function FeedPage() {
  const search = feedRoute.useSearch();
  const { q } = feedRoute.useRouteContext();
  const { data: tags } = useSuspenseQuery(q.tags());
  const feed = useSuspenseInfiniteQuery(q.feed(search));
  usePageTitle(null);

  const { fetchNextPage } = feed;
  const items = useMemo(() => feed.data.pages.flatMap((page) => page.items), [feed.data]);
  // Stable: `LoadMore` re-creates its observer whenever this identity changes.
  const onMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  return (
    <div className="page feed-page">
      <div className="feed-head">
        <SearchBar value={search.q ?? ""} scope={search.scope} to="/search" />
        <ScopeLinks scope={search.scope} on="/" />
      </div>
      <CategoryTabs tags={tags} search={search} />
      {search.q && (
        <p className="meta feed-filter">
          筛选：「{search.q}」
          <Link to="/" search={(s) => ({ ...s, q: undefined })} aria-label="清除关键词">
            ×
          </Link>
        </p>
      )}
      {items.length === 0 ? (
        <p className="empty">没有匹配的文章</p>
      ) : (
        <div className="feed-rows">
          {items.map((article) => (
            <ArticleRow key={article.id} article={article} />
          ))}
        </div>
      )}
      <LoadMore hasNext={feed.hasNextPage} isFetching={feed.isFetchingNextPage} onMore={onMore} />
    </div>
  );
}
