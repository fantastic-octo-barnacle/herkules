import type { Segment } from "./snippet.ts";

/** Wire segments as text; `hit` runs as `<mark>`. No parsing — the wire is already segments. */
export function Snippet({ segments }: { segments: readonly Segment[] }) {
  return (
    <p className="mt-0.5 max-w-[var(--measure)] text-[13.5px] leading-[22px] text-ink-2">
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
