import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { ArticleAiDTO } from "../../../src/api/dto.ts";

type KbEntry = NonNullable<ArticleAiDTO["kb"]>;

/**
 * The 规格 panel: the structured facts the model extracted, each section shown
 * only when it has rows. The page gates the whole panel (and its dock button)
 * on `hasContent(kb)` — rm-wenku showed an empty panel for every article whose
 * KB row happened to be all-empty lists.
 *
 * `KbPanelBody` is everything that is not a router link, split out so the
 * tables and lists can be rendered in a test without a router.
 */
export function KbPanel({ kb }: { kb: KbEntry }) {
  return (
    <div className="reader-kb">
      <KbPanelBody kb={kb} />
      {kb.entities.length > 0 && (
        <div className="reader-kb-sec">
          <span className="label">相关条目</span>
          <div className="reader-kb-chips">
            {kb.entities.map((name) => (
              <Link className="chip" key={name} to="/kb/$name" params={{ name }}>
                {name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function KbPanelBody({ kb }: { kb: KbEntry }) {
  return (
    <>
      <p className="fine">AI 提取，标注来源。</p>
      {(kb.problem ?? kb.approach) && (
        <div className="reader-kb-sec">
          {kb.problem && (
            <p>
              <b>问题</b> {kb.problem}
            </p>
          )}
          {kb.approach && (
            <p>
              <b>路线</b> {kb.approach}
            </p>
          )}
        </div>
      )}
      {kb.parameters.length > 0 && (
        <Section title="参数" count={kb.parameters.length} open>
          <table className="reader-kb-table">
            <tbody>
              {kb.parameters.map((p, index) => (
                <tr key={index}>
                  <td>{p.name}</td>
                  <td className="num">
                    {p.value}
                    {p.unit ? ` ${p.unit}` : ""}
                  </td>
                  <td className="ctx">
                    {p.context}
                    {p.source && <span className="src">{p.source}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {kb.components.length > 0 && (
        <Section title="组件" count={kb.components.length}>
          <ul className="reader-kb-list">
            {kb.components.map((c, index) => (
              <li key={index}>
                <b>{c.name}</b>
                {c.kind && <span className="kind">{c.kind}</span>}
                {c.spec && <span> {c.spec}</span>}
                {c.role && <span className="fine"> — {c.role}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.designDecisions.length > 0 && (
        <Section title="取舍" count={kb.designDecisions.length}>
          <ul className="reader-kb-list">
            {kb.designDecisions.map((d, index) => (
              <li key={index}>
                <b>{d.decision}</b>
                {d.alternatives && <span className="fine"> 而非 {d.alternatives}</span>}
                {d.rationale && <div className="why">{d.rationale}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.pitfalls.length > 0 && (
        <Section title="踩坑" count={kb.pitfalls.length} open>
          <ul className="reader-kb-list">
            {kb.pitfalls.map((p, index) => (
              <li key={index}>{p}</li>
            ))}
          </ul>
        </Section>
      )}
      {(kb.interfaces.length > 0 || kb.toolchain.length > 0 || kb.cost) && (
        <Section title="接口 · 工具链 · 成本">
          {kb.interfaces.length > 0 && (
            <p>
              <b>接口</b> {kb.interfaces.join("、")}
            </p>
          )}
          {kb.toolchain.length > 0 && (
            <p>
              <b>工具链</b> {kb.toolchain.join("、")}
            </p>
          )}
          {kb.cost && (
            <p>
              <b>成本</b> {kb.cost}
            </p>
          )}
        </Section>
      )}
      {kb.claims.length > 0 && (
        <Section title="作者主张" count={kb.claims.length}>
          <ul className="reader-kb-list">
            {kb.claims.map((c, index) => (
              <li key={index}>
                {c.claim}
                {c.evidence && <span className="fine"> — {c.evidence}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.references.length > 0 && (
        <Section title="参考" count={kb.references.length}>
          <ul className="reader-kb-list">
            {kb.references.map((r, index) => (
              <li key={index}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                    {r.title}
                  </a>
                ) : (
                  r.title
                )}
                {r.relation && <span className="kind">{r.relation}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kb.openQuestions.length > 0 && (
        <Section title="没说清的" count={kb.openQuestions.length}>
          <ul className="reader-kb-list">
            {kb.openQuestions.map((q, index) => (
              <li key={index}>{q}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** `<details>` rather than a state hook: the browser already owns this toggle. */
function Section({
  title,
  count,
  open,
  children,
}: {
  title: string;
  count?: number;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="reader-kb-sec" open={open}>
      <summary>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </summary>
      {children}
    </details>
  );
}
