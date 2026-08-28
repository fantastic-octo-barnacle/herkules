/** One not-found rendering: the root notFoundComponent and screens whose query returned null. */
import { Button } from "@herkules/ui/components/button";
import { Link } from "@tanstack/react-router";

const TEXT = { article: "文章不存在", entity: "条目不存在", page: "页面不存在" } as const;

export function NotFound({ what = "page" }: { what?: "article" | "entity" | "page" }) {
  return (
    <div className="page">
      <section
        className="mx-auto my-12 max-w-[34rem] rounded-lg border border-line bg-surface p-6 [&_p]:text-ink-2"
        data-not-found={what}
      >
        <p className="eyebrow mb-1.5">404</p>
        <h1 className="page-title">{TEXT[what]}</h1>
        <p>它可能已经被删除，或者链接抄错了一个字符。</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/">回到文章列表</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
