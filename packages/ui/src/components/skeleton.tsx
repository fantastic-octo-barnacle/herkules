import { cn } from "@herkules/ui/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // shadcn's default `bg-accent` assumes a subtle grey accent; ours is the
      // saturated brand green, which painted every placeholder as a pulsing green
      // block. `accent-soft` is the quiet tinted token.
      className={cn("animate-pulse rounded-md bg-accent-soft", className)}
      {...props}
    />
  );
}

export { Skeleton };
