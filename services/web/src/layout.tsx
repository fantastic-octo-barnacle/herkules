/** The page furniture every screen repeats: title, eyebrow, lede, empty state, card, action row. */
import { cn } from "@herkules/ui/lib/utils";
import type { ComponentProps } from "react";

export function Eyebrow({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("eyebrow mb-1.5", className)} {...props} />;
}

export function PageTitle({ className, ...props }: ComponentProps<"h1">) {
  return <h1 className={cn("page-title", className)} {...props} />;
}

export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2 className={cn("mt-8 mb-3 font-display text-[1.35rem] font-medium", className)} {...props} />
  );
}

export function Lede({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("lede", className)} {...props} />;
}

export function Empty({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("py-6 text-muted-foreground", className)} {...props} />;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <Empty>{label}…</Empty>;
}

/** A framed panel centred in the viewport (login, consent). */
export function CenteredCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className="grid flex-1 place-items-center px-4 py-8">
      <div
        className={cn(
          "w-full max-w-[30rem] rounded-md border border-line bg-surface p-8 [&_h1]:text-[1.6rem]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function Actions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-5 flex flex-wrap gap-3", className)} {...props} />;
}

export function Sub({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-[0.8rem] text-muted-foreground", className)} {...props} />;
}
