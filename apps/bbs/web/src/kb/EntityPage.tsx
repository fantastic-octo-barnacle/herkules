/**
 * `/kb/$name` — one entity across every article that mentions it. The page is
 * `entitySections()` plus the article list; `null` from the query means the
 * server said 404, which is data, not an error.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { formatDate } from "../lib/format.ts";
import { entityRoute } from "../routes.tsx";
import { NotFound } from "../shell/NotFound.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import type { ArticleRef } from "./EntitySectionsView.tsx";
import { EntitySectionsView } from "./EntitySectionsView.tsx";
import "./kb.css";
import { entitySections } from "./model.ts";

export function EntityPage() {
  const { name } = entityRoute.useParams();
  const { q } = entityRoute.useRouteContext();
  const { data } = useSuspenseQuery(q.entity(name));
  usePageTitle(data?.entity.name ?? null);
  // `key` is the folded key the server matched on, not the display name.
  const sections = useMemo(
    () => (data ? entitySections(data.entity.key, data.articles) : null),
    [data],
  );

  if (!data || !sections) return <NotFound what="entity" />;
  const { entity, articles } = data;

  return (
    <div className="page kb-entity">
      <Link className="kb-back" to="/kb">
        ‹ 知识库
      </Link>
      <span className="eyebrow">条目 · {entity.articleCount} 篇</span>
      <h1 className="page-title">{entity.name}</h1>

      <EntitySectionsView sections={sections} renderArticle={renderArticle} />

      <section className="kb-panel">
        <h2 className="kb-panel-title">提到它的文章</h2>
        <ul className="kb-articles">
          {articles.map((a) => (
            <li key={a.articleId}>
              <Link to="/articles/$id" params={{ id: a.articleId }}>
                {a.title}
              </Link>
              <span className="meta">
                {[a.author, formatDate(a.publishedAt)].filter(Boolean).join(" · ")}
              </span>
              {a.tldr && <p>{a.tldr}</p>}
            </li>
          ))}
        </ul>
      </section>

      <p className="kb-fine">
        内容由模型从各篇文章提取，参数的测量条件可能不同，对比前请核对来源。
      </p>
    </div>
  );
}

/** Module scope, not a closure: the sections view re-renders with a stable prop. */
function renderArticle(ref: ArticleRef) {
  return (
    <Link to="/articles/$id" params={{ id: ref.articleId }}>
      {ref.title}
    </Link>
  );
}
