/** Shown only when a load is actually slow (defaultPendingMs), never for a single frame. */

const ROWS = [0, 1, 2, 3, 4, 5];
const LINES = [0, 1, 2, 3, 4, 5, 6, 7];

export function FeedSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="载入中">
      {ROWS.map((row) => (
        <div className="skel-row" key={row}>
          <div className="skel-line is-meta" />
          <div className="skel-line is-title" />
          <div className="skel-line is-text" />
        </div>
      ))}
    </div>
  );
}

export function ReaderSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="载入中">
      <div className="skel-row">
        <div className="skel-line is-meta" />
        <div className="skel-line is-title" />
      </div>
      <div className="skel-reader">
        {LINES.map((line) => (
          <div className={line % 4 === 3 ? "skel-line is-short" : "skel-line is-text"} key={line} />
        ))}
      </div>
    </div>
  );
}
