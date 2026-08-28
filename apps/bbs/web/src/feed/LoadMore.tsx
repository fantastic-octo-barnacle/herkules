import { Button } from "@herkules/ui/components/button";
import { useEffect, useRef } from "react";

/** Start fetching the next page this far before the sentinel scrolls into view. */
const PREFETCH_MARGIN = "800px 0px";

const MORE = "flex flex-col items-center gap-2.5 pt-7 pb-12";

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

  if (!hasNext)
    return <p className={`${MORE} font-mono text-xs text-muted-foreground`}>没有更多了</p>;

  return (
    <div className={MORE} role="status" aria-live="polite">
      <div ref={sentinel} className="h-px" aria-hidden="true" />
      <Button variant="outline" onClick={onMore} disabled={isFetching}>
        {isFetching ? "加载中…" : "加载更多"}
      </Button>
    </div>
  );
}
