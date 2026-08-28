/**
 * The router-free half of a KB card: everything above the chip row. Split out so
 * `renderToString` can smoke-render a card's body without a router — the title
 * and the chips are `<Link>`s and stay in `KbPage`.
 */
import type { KbBrowseDTO } from "../../../src/api/dto.ts";
import { maturityClass } from "../lib/ai.ts";
import { formatDate } from "../lib/format.ts";

export type KbCardDTO = KbBrowseDTO["cards"][number];

export function KbCardBody({ card }: { card: KbCardDTO }) {
  // `filter(Boolean)` drops a missing author instead of printing an empty column.
  const meta = [card.author, formatDate(card.publishedAt)].filter(Boolean).join(" · ");
  const maturity = maturityClass(card.maturity);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 max-md:flex-col max-md:gap-0.5">
        <span className="meta">{meta}</span>
        {maturity && <span className={maturity}>{card.maturity}</span>}
      </div>
      {card.tldr && <p className="m-0 text-[14.5px] leading-[1.7] text-ink-2">{card.tldr}</p>}
      {/* The model often repeats the tldr as the problem; showing it twice reads as a bug. */}
      {card.problem && card.problem !== card.tldr && (
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
          问题：{card.problem}
        </p>
      )}
    </>
  );
}
