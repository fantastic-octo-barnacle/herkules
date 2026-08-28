/**
 * `/kb` — the knowledge-base browse screen: facets, the card grid, and a summary
 * column (pitfall teaser + entity tallies) derived from the SAME cards the grid
 * shows, so the tallies always agree with the current filter (`kb/model.ts`).
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";

import type { KbBrowseDTO } from "../../../src/api/dto.ts";
import { kbRoute } from "../routes.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import type { KbSearch } from "../url.ts";
import { KbCardBody } from "./KbCard.tsx";
import type { KbCardDTO } from "./KbCard.tsx";
import "./kb.css";
import { PITFALL_LIMIT, countEntities, roundRobin, splitEntities } from "./model.ts";

type FacetCount = KbBrowseDTO["genres"][number];
/** A `<Link search>` updater: the current URL state in, the next one out. */
type Patch = (value: string | undefined) => (s: KbSearch) => KbSearch;

export function KbPage() {
  usePageTitle("知识库");
  const search = kbRoute.useSearch();
  const { q } = kbRoute.useRouteContext();
  const { data } = useSuspenseQuery(q.kbBrowse(search));
  const navigate = useNavigate();

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // `FormData.get` widens to `File`; a `<input type="search">` can only be a string.
    const raw = new FormData(event.currentTarget).get("q");
    const text = typeof raw === "string" ? raw.trim() : "";
    // The KB box is the ranked endpoint scoped to KB text, not a facet filter.
    void navigate({ to: "/search", search: { q: text, scope: "kb" } });
  };

  const cards = data.cards;
  // `roundRobin` is generic over lists, so the card each pitfall came from is
  // paired in before the interleave — the feed needs both to link back.
  const pitfalls = roundRobin(
    cards.map((card) => card.pitfalls.map((text) => ({ card, text }))),
    PITFALL_LIMIT,
  );
  const tallies = countEntities(cards);
  const { common, rest } = splitEntities(tallies);

  return (
    <div className="page kb-page">
      <h1 className="page-title">知识库</h1>
      <p className="kb-lede">
        每篇文章的 AI
        概览同时提取一份结构化条目：结论、成熟度、用到的型号与库、带单位的参数、作者做过的取舍和踩过的坑。
        这里按体裁、领域和兵种筛选；下面汇总当前这些文章的踩坑与出现最多的条目，点开一个条目可跨队伍对比。
      </p>

      <form className="kb-search" onSubmit={onSearch} role="search">
        <input
          type="search"
          name="q"
          defaultValue={search.q ?? ""}
          placeholder="搜知识库：EtherCAT、卡弹、CAN FD、减速比…"
          aria-label="搜索知识库"
          autoComplete="off"
        />
        <button className="btn btn-primary" type="submit">
          搜索
        </button>
      </form>

      <div className="kb-facets">
        <FacetRow
          lead="体裁"
          items={data.genres}
          current={search.genre}
          patch={(genre) => (s) => ({ ...s, genre })}
        />
        <FacetRow
          lead="领域"
          items={data.domains}
          current={search.domain}
          patch={(domain) => (s) => ({ ...s, domain })}
        />
        <FacetRow
          lead="兵种"
          items={data.robotTypes}
          current={search.robot}
          patch={(robot) => (s) => ({ ...s, robot })}
        />
      </div>

      <p className="meta kb-total">当前筛选：{data.total} 篇文章</p>

      <div className="kb-grid">
        <aside className="kb-side" aria-label="汇总">
          {pitfalls.length > 0 && (
            <section>
              <h2 className="eyebrow">踩坑速览</h2>
              <ul className="kb-pitfalls">
                {pitfalls.map(({ card, text }, i) => (
                  <li key={`${card.articleId}-${i}`}>
                    {text}
                    <Link className="kb-ref" to="/articles/$id" params={{ id: card.articleId }}>
                      {card.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {common.length > 0 && (
            <section>
              <h2 className="eyebrow">常见条目</h2>
              <div className="kb-cloud">
                {common.map((e) => (
                  <Link className="chip" key={e.name} to="/kb/$name" params={{ name: e.name }}>
                    {e.name}
                    <small>{e.count}</small>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {rest.length > 0 && (
            <details className="kb-rest">
              <summary>
                全部条目<small>{tallies.length}</small>
              </summary>
              <div className="kb-cloud">
                {rest.map((e) => (
                  <Link className="chip" key={e.name} to="/kb/$name" params={{ name: e.name }}>
                    {e.name}
                  </Link>
                ))}
              </div>
            </details>
          )}
        </aside>

        <ol className="kb-cards">
          {cards.length === 0 && <li className="empty">没有匹配的条目</li>}
          {cards.map((card) => (
            <Card key={card.articleId} card={card} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function FacetRow({
  lead,
  items,
  current,
  patch,
}: {
  lead: string;
  items: readonly FacetCount[];
  current: string | undefined;
  patch: Patch;
}) {
  // A stale filter with no cards left still needs its chip, or it cannot be cleared.
  if (items.length === 0 && !current) return null;
  return (
    <div className="kb-facet">
      <span className="eyebrow kb-facet-lead">{lead}</span>
      {items.map((item) => {
        const active = current === item.name;
        return (
          <Link
            className={active ? "chip is-active" : "chip"}
            key={item.name}
            to="/kb"
            // Clicking the active chip clears the axis: the chip is the toggle.
            search={patch(active ? undefined : item.name)}
            aria-current={active ? "true" : undefined}
          >
            {item.name}
            <small>{item.count}</small>
          </Link>
        );
      })}
    </div>
  );
}

function Card({ card }: { card: KbCardDTO }) {
  // Cards carry the raw forum title (no `titleParts` on the KB wire), so it is shown as-is.
  const entities = card.entities.slice(0, 6);
  return (
    <li className="card kb-card">
      <h2 className="kb-card-title">
        <Link to="/articles/$id" params={{ id: card.articleId }}>
          {card.title}
        </Link>
      </h2>
      <KbCardBody card={card} />
      <div className="kb-card-foot">
        {card.genre && (
          <Link className="chip" to="/kb" search={(s) => ({ ...s, genre: card.genre })}>
            {card.genre}
          </Link>
        )}
        {card.domain.map((d) => (
          <Link className="chip" key={`d-${d}`} to="/kb" search={(s) => ({ ...s, domain: d })}>
            {d}
          </Link>
        ))}
        {card.robotTypes.map((r) => (
          <Link className="chip" key={`r-${r}`} to="/kb" search={(s) => ({ ...s, robot: r })}>
            {r}
          </Link>
        ))}
        {entities.length > 0 && <span className="kb-card-sep" aria-hidden="true" />}
        {entities.map((e) => (
          <Link className="chip" key={`e-${e}`} to="/kb/$name" params={{ name: e }}>
            {e}
          </Link>
        ))}
      </div>
    </li>
  );
}
