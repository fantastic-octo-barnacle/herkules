import { Badge } from "@herkules/ui/components/badge";
import { Link } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { ArticleRow } from "../feed/ArticleRow.tsx";
import { LoadMore } from "../feed/LoadMore.tsx";
import { ScopeLinks, SearchBar } from "../feed/SearchBar.tsx";
import { searchRoute } from "../routes.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { trimSegments } from "./snippet.ts";

/** `/search` — ranked hits. A blank `q` never reaches here (the route redirects to `/`). */
export function SearchPage() {
  const search = searchRoute.useSearch();
  const { q } = searchRoute.useRouteContext();
  const results = useSuspenseInfiniteQuery(q.search({ ...search, q: search.q ?? "" }));
  usePageTitle(`搜索：${search.q ?? ""}`);

  const { fetchNextPage } = results;
  const pages = results.data.pages;
  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const onMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  // The terms the engine actually searched (folded, de-duplicated) — the same on every page.
  const terms = pages[0]?.terms ?? [];

  return (
    <div className="page">
      <div className="flex flex-wrap items-center gap-2.5 pt-2">
        <SearchBar value={search.q ?? ""} scope={search.scope} to="/search" />
        <ScopeLinks scope={search.scope} on="/search" />
      </div>
      <p className="meta flex flex-wrap items-center gap-1.5 pt-3.5">
        <span>已搜索：</span>
        {terms.map((term) => (
          <Badge variant="outline" className="font-mono" key={term}>
            {term}
          </Badge>
        ))}
        <Link
          className="ml-auto"
          to="/"
          search={{ q: search.q, scope: search.scope, tag: search.tag, group: search.group }}
        >
          按发布时间排列
        </Link>
      </p>
      {items.length === 0 ? (
        <p className="py-6 text-muted-foreground">没有匹配的文章</p>
      ) : (
        <div className="mt-4">
          {items.map((hit) => (
            <ArticleRow
              key={hit.id}
              article={hit}
              snippet={hit.snippet ? trimSegments(hit.snippet) : undefined}
            />
          ))}
        </div>
      )}
      <LoadMore
        hasNext={results.hasNextPage}
        isFetching={results.isFetchingNextPage}
        onMore={onMore}
      />
    </div>
  );
}
