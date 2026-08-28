/**
 * The entity page's five sections over plain data. Router-free on purpose: it
 * takes a `renderArticle` prop instead of importing `<Link>`, so the table and
 * the empty-section rule can be smoke-rendered without a router.
 */
import type { ReactNode } from "react";

import type { EntitySections } from "./model.ts";

export interface ArticleRef {
  readonly articleId: string;
  readonly title: string;
}

/** How a row points back at the article it came from. */
export type RenderArticle = (ref: ArticleRef) => ReactNode;

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
        <section className="kb-panel">
          <h2 className="kb-panel-title">参数对比</h2>
          <div className="kb-table-wrap">
            <table className="kb-table">
              <thead>
                <tr>
                  <th>参数</th>
                  <th className="kb-num">值</th>
                  <th>条件</th>
                  <th>文章</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row, i) => (
                  <tr key={i}>
                    <td>{row.name}</td>
                    <td className="kb-num">{row.unit ? `${row.value} ${row.unit}` : row.value}</td>
                    <td>{row.context}</td>
                    <td>{renderArticle(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {otherParameters.length > 0 && (
        <section className="kb-panel">
          <h2 className="kb-panel-title">其他参数</h2>
          <div className="kb-table-wrap">
            <table className="kb-table">
              <tbody>
                {otherParameters.map((row, i) => (
                  <tr key={i}>
                    <td>{row.name}</td>
                    <td className="kb-num">{row.unit ? `${row.value} ${row.unit}` : row.value}</td>
                    <td>{renderArticle(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {asComponent.length > 0 && (
        <section className="kb-panel">
          <h2 className="kb-panel-title">作为组件</h2>
          <ul className="kb-list">
            {asComponent.map((row, i) => (
              <li key={i}>
                {row.spec && <b>{row.spec}</b>}
                {row.role && (
                  <span className="kb-fine">{row.spec ? ` — ${row.role}` : row.role}</span>
                )}
                <span className="kb-ref">{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className="kb-panel">
          <h2 className="kb-panel-title">相关取舍</h2>
          <ul className="kb-list">
            {decisions.map((row, i) => (
              <li key={i}>
                <b>{row.decision}</b>
                {row.rationale && <div className="kb-fine">{row.rationale}</div>}
                <span className="kb-ref">{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pitfalls.length > 0 && (
        <section className="kb-panel">
          <h2 className="kb-panel-title">相关踩坑</h2>
          <ul className="kb-list kb-list-pitfalls">
            {pitfalls.map((row, i) => (
              <li key={i}>
                {row.pitfall}
                <span className="kb-ref">{renderArticle(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
