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
      <div className="kb-card-top">
        <span className="meta">{meta}</span>
        {maturity && <span className={maturity}>{card.maturity}</span>}
      </div>
      {card.tldr && <p className="kb-card-tldr">{card.tldr}</p>}
      {/* The model often repeats the tldr as the problem; showing it twice reads as a bug. */}
      {card.problem && card.problem !== card.tldr && (
        <p className="kb-card-problem">问题：{card.problem}</p>
      )}
    </>
  );
}
