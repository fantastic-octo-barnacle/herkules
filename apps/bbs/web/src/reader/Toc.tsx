import { useEffect, useState } from "react";

import type { Heading } from "./prose.ts";

/**
 * Scroll spy over the headings `prepareProse` gave ids to. It lives beside
 * `Toc` rather than inside it so the component stays a pure function of props
 * (and therefore renderable in a plain `renderToString` test), and so the page
 * can hand the same `activeId` to a second consumer later.
 *
 * The rootMargin keeps the "current" heading in the top tenth of the viewport:
 * a heading counts as reached once it has scrolled up past that band.
 */
export function useActiveHeading(headings: readonly Heading[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const targets = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: 0 },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  return activeId;
}

/**
 * The table of contents. Hash anchors, not router links: the target is a node
 * of the page already on screen, so the browser's own fragment scrolling (plus
 * `scroll-margin-top` in the sheet) is exactly the wanted behaviour.
 */
export function Toc({
  headings,
  activeId,
}: {
  headings: readonly Heading[];
  activeId: string | null;
}) {
  return (
    <nav className="reader-toc" aria-label="目录">
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          data-level={h.level}
          aria-current={activeId === h.id ? "true" : undefined}
        >
          {h.text}
        </a>
      ))}
    </nav>
  );
}
