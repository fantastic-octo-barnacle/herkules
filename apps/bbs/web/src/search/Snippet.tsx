import type { Segment } from "./snippet.ts";

/** Wire segments as text; `hit` runs as `<mark>`. No parsing — the wire is already segments. */
export function Snippet({ segments }: { segments: readonly Segment[] }) {
  return (
    <p className="search-snippet">
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
