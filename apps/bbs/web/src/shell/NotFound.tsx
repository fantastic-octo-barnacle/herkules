/** One not-found rendering: the root notFoundComponent and screens whose query returned null. */
import { Link } from "@tanstack/react-router";

const TEXT = { article: "文章不存在", entity: "条目不存在", page: "页面不存在" } as const;

export function NotFound({ what = "page" }: { what?: "article" | "entity" | "page" }) {
  return (
    <div className="page">
      <section className="card shell-state" data-not-found={what}>
        <p className="eyebrow">404</p>
        <h1 className="page-title">{TEXT[what]}</h1>
        <p>它可能已经被删除，或者链接抄错了一个字符。</p>
        <div className="shell-state-actions">
          <Link className="btn btn-primary" to="/">
            回到文章列表
          </Link>
        </div>
      </section>
    </div>
  );
}
