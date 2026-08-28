/**
 * The status numbers, with no router and no query — its own module so a test can
 * render it from a fixture DTO without pulling `routes.tsx` (and with it every
 * screen) into the module graph.
 */
import type { LibraryStatusDTO } from "../../../src/api/dto.ts";
import { formatDate } from "../lib/format.ts";
import "./status.css";

/** The import stamp is the one place a day is too coarse: it answers "how fresh is this?". */
const STAMP = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

export function stampText(iso: string | null): string {
  if (!iso) return "未知时间";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "未知时间" : STAMP.format(ms);
}

export function StatusTiles({ status }: { status: LibraryStatusDTO }) {
  const { articles, ai, crawler } = status;
  return (
    <div className="status-tiles" aria-label="进度概览">
      <section className="card status-tile">
        <span className="eyebrow">文库</span>
        <span className="status-big">
          {articles.fetched}
          <small>篇正文</small>
        </span>
        <span className="meta">
          共 {articles.total} 篇 · 跳过 {articles.skipped}
          <br />
          标签 {articles.tags} · 图 {articles.images} · 链接 {articles.links}
        </span>
      </section>
      <section className="card status-tile">
        <span className="eyebrow">AI 概览</span>
        <span className="status-big">
          {ai.ready}
          <small>篇已生成</small>
        </span>
        <span className="meta">
          待生成 {ai.missing}
          <br />
          知识库条目 {ai.entities}
        </span>
      </section>
      <section className="card status-tile">
        <span className="eyebrow">抓取</span>
        <span className="status-big">
          {formatDate(crawler.lastCheckedAt)}
          <small>最近检查</small>
        </span>
        <span className="meta">
          历史回填{" "}
          {crawler.backfillCompletedAt
            ? `已于 ${formatDate(crawler.backfillCompletedAt)} 完成`
            : "尚未完成"}
          <br />
          抓取仍在原服务器上运行
        </span>
      </section>
    </div>
  );
}
