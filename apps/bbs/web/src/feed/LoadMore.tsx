import { useEffect, useRef } from "react";

/** Start fetching the next page this far before the sentinel scrolls into view. */
const PREFETCH_MARGIN = "800px 0px";

/**
 * Infinite paging, two ways: a sentinel the observer watches, and a button for
 * browsers without `IntersectionObserver` (and for keyboard users, who never
 * scroll it into view).
 */
export function LoadMore({
  hasNext,
  isFetching,
  onMore,
}: {
  hasNext: boolean;
  isFetching: boolean;
  onMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNext || isFetching || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, isFetching, onMore]);

  if (!hasNext) return <p className="feed-more feed-more-end">没有更多了</p>;

  return (
    <div className="feed-more" role="status" aria-live="polite">
      <div ref={sentinel} className="feed-sentinel" aria-hidden="true" />
      <button className="btn" type="button" onClick={onMore} disabled={isFetching}>
        {isFetching ? "加载中…" : "加载更多"}
      </button>
    </div>
  );
}
