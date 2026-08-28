/**
 * `/status` — three tiles over one snapshot. rm-wenku's SSE console, live dot and
 * clock-skew countdown are gone on purpose: the crawler runs on the old box and
 * this corpus arrives by import, so there is nothing here that changes while you watch.
 */
import { useSuspenseQuery } from "@tanstack/react-query";

import { usePageTitle } from "../shell/usePageTitle.ts";
import { statusRoute } from "../routes.tsx";
import { StatusTiles, stampText } from "./StatusTiles.tsx";

export function StatusPage() {
  usePageTitle("状态");
  const { q } = statusRoute.useRouteContext();
  const { data: status } = useSuspenseQuery(q.status());
  return (
    <div className="page">
      <h1 className="page-title">状态</h1>
      <p className="lede">
        本站是 {status.site.name} 公开文章的归档副本：正文、标签、图片与链接按批次导入，AI
        概览逐篇生成。下面是这一份副本的规模。
      </p>
      <StatusTiles status={status} />
      <p className="meta mt-2">本库导入于 {stampText(status.importedAt)}（北京时间）</p>
    </div>
  );
}
