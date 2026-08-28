/** Shown only when a load is actually slow (defaultPendingMs), never for a single frame. */
import { Skeleton } from "@herkules/ui/components/skeleton";

const ROWS = [0, 1, 2, 3, 4, 5];
const LINES = [0, 1, 2, 3, 4, 5, 6, 7];

const LINE = "h-[0.7rem] rounded-[3px] bg-line-2";

export function FeedSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="载入中">
      {ROWS.map((row) => (
        <div className="grid gap-2 border-b border-line-2 py-[1.1rem]" key={row}>
          <Skeleton className={`${LINE} w-[35%]`} />
          <Skeleton className={`${LINE} h-[1.1rem] w-[60%]`} />
          <Skeleton className={`${LINE} w-[92%]`} />
        </div>
      ))}
    </div>
  );
}

export function ReaderSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="载入中">
      <div className="grid gap-2 border-b border-line-2 py-[1.1rem]">
        <Skeleton className={`${LINE} w-[35%]`} />
        <Skeleton className={`${LINE} h-[1.1rem] w-[60%]`} />
      </div>
      <div className="grid gap-[0.6rem] py-4">
        {LINES.map((line) => (
          <Skeleton className={`${LINE} ${line % 4 === 3 ? "w-[74%]" : "w-[92%]"}`} key={line} />
        ))}
      </div>
    </div>
  );
}
