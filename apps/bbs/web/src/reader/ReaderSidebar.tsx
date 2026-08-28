import { useEffect, useState, type ReactNode } from "react";

const NARROW = "(max-width: 960px)";

/** Tracks the sidebar's breakpoint so the closed sheet can be `inert` (off-screen links must not take focus). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}

export type SectionId = "toc" | "ai" | "kb" | "resources";

export interface SidebarSection {
  readonly id: SectionId;
  readonly label: string;
  readonly node: ReactNode;
}

/**
 * One component, two shapes (the CSS decides which at 960 px):
 *
 *  - wide: a sticky column holding every section at once,
 *  - narrow: a fixed dock of one button per section that raises the same
 *    column as a bottom sheet and scrolls it to the section asked for.
 *
 * The open section is therefore state only the narrow layout can enter: on a
 * wide screen the dock is `display: none`, so nothing can set it.
 */
export function ReaderSidebar({ sections }: { sections: readonly SidebarSection[] }) {
  const [open, setOpen] = useState<SectionId | null>(null);
  const narrow = useNarrow();

  useEffect(() => {
    if (!open) return;
    document.getElementById(`reader-side-${open}`)?.scrollIntoView({ block: "start" });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    // The sheet scrolls itself; the page behind it must not scroll with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (sections.length === 0) return null;

  return (
    <>
      {open && (
        <div className="reader-sheet-backdrop" onClick={() => setOpen(null)} aria-hidden="true" />
      )}
      <aside
        className="reader-side"
        data-open={open ? "true" : undefined}
        inert={narrow && !open}
        aria-label="文章辅助"
      >
        <button className="reader-sheet-close" type="button" onClick={() => setOpen(null)}>
          收起
        </button>
        {sections.map((section) => (
          <section className="reader-side-sec" id={`reader-side-${section.id}`} key={section.id}>
            <h2 className="reader-side-head">{section.label}</h2>
            {section.node}
          </section>
        ))}
      </aside>
      <div className="reader-dock" role="toolbar" aria-label="文章辅助">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-pressed={open === section.id}
            onClick={() => setOpen(open === section.id ? null : section.id)}
          >
            {section.label}
          </button>
        ))}
      </div>
    </>
  );
}
