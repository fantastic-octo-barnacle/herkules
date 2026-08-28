/**
 * The entity page's five sections over plain data. Router-free on purpose: it
 * takes a `renderArticle` prop instead of importing `<Link>`, so the table and
 * the empty-section rule can be smoke-rendered without a router.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import type { ReactNode } from "react";

import type { EntitySections } from "./model.ts";

export interface ArticleRef {
  readonly articleId: string;
  readonly title: string;
}

/** How a row points back at the article it came from. */
export type RenderArticle = (ref: ArticleRef) => ReactNode;

export const PANEL = "mt-7 border-t border-line-2 pt-[18px]";
export const PANEL_TITLE = "m-0 mb-3 font-body text-[15px] font-semibold";
const LIST = "flex flex-col gap-3.5 text-sm leading-[1.7]";
const FINE = "text-[13px] leading-relaxed text-muted-foreground";
const REF =
  "mt-0.5 block font-mono text-[11.5px] text-muted-foreground [&_a]:text-inherit [&_a:hover]:text-accent";
/** Datasheet cells: mono numbers never wrap; the article column does (forum titles are long). */
const NUM = "font-mono whitespace-nowrap";
const HEAD = "font-mono text-xs font-medium text-muted-foreground";

export function EntitySectionsView({
  sections,
  renderArticle,
}: {
  sections: EntitySections;
  renderArticle: RenderArticle;
}) {
  const { comparison, otherParameters, asComponent, decisions, pitfalls } = sections;
  return (
    <>
      {comparison.length > 0 && (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>参数对比</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD}>参数</TableHead>
                <TableHead className={`${HEAD} ${NUM}`}>值</TableHead>
                <TableHead className={HEAD}>条件</TableHead>
                <TableHead className={HEAD}>文章</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparison.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="min-w-[8em] align-top">{row.name}</TableCell>
                  <TableCell className={`${NUM} align-top`}>
                    {row.unit ? `${row.value} ${row.unit}` : row.value}
                  </TableCell>
                  <TableCell className="align-top">{row.context}</TableCell>
                  <TableCell className="min-w-[14em] align-top whitespace-normal">
                    {renderArticle(row)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {otherParameters.length > 0 && (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>其他参数</h2>
          <Table>
            <TableBody>
              {otherParameters.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="min-w-[8em] align-top">{row.name}</TableCell>
                  <TableCell className={`${NUM} align-top`}>
                    {row.unit ? `${row.value} ${row.unit}` : row.value}
                  </TableCell>
                  <TableCell className="min-w-[14em] align-top whitespace-normal">
                    {renderArticle(row)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {asComponent.length > 0 && (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>作为组件</h2>
          <ul className={LIST}>
            {asComponent.map((row, i) => (
              <li key={i}>
                {row.spec && <b>{row.spec}</b>}
                {row.role && <span className={FINE}>{row.spec ? ` — ${row.role}` : row.role}</span>}
                <span className={REF}>{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>相关取舍</h2>
          <ul className={LIST}>
            {decisions.map((row, i) => (
              <li key={i}>
                <b>{row.decision}</b>
                {row.rationale && <div className={FINE}>{row.rationale}</div>}
                <span className={REF}>{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pitfalls.length > 0 && (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>相关踩坑</h2>
          <ul className={LIST}>
            {pitfalls.map((row, i) => (
              <li className="border-l-2 border-warn pl-3" key={i}>
                {row.pitfall}
                <span className={REF}>{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
