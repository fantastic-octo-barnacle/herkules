import { createHash } from "node:crypto";

import { truncateChars } from "../content/text.ts";
import type {
  ArticleSummary,
  LibraryStatus,
  SearchHit,
  SearchPage,
  SearchScope,
  SnippetSegment,
} from "../library/types.ts";
import type { Card, CardElement } from "./cards.ts";
import {
  buttonRow,
  callbackButton,
  card,
  errorCard,
  hr,
  kvTable,
  link,
  linkButton,
  markdown,
  md,
  note,
} from "./cards.ts";
import { COMMANDS } from "./command.ts";
import type { SearchAction } from "./command.ts";
import { hongKongDay } from "./time.ts";

export interface ArticleSnapshot {
  readonly title: string;
  readonly excerpt: string | null;
  readonly articleLink: string;
}

export interface FrozenPayload {
  readonly msgType: "text" | "interactive";
  readonly content: string;
  readonly hash: string;
}

export const SEARCH_PAGE_SIZE = 5;

const SCOPE_LABEL: Record<SearchScope, string> = {
  all: "全文",
  title: "仅标题",
  kb: "知识库",
};

const HELP_HINT = "发送 /help 查看全部命令。";

function freeze(msgType: FrozenPayload["msgType"], content: string): FrozenPayload {
  return {
    msgType,
    content,
    hash: createHash("sha256").update(`${msgType}\0${content}`).digest("hex"),
  };
}

function freezeCard(value: Card): FrozenPayload {
  return freeze("interactive", JSON.stringify(value));
}

export function articleLink(appOrigin: string, id: string): string {
  return `${appOrigin}/articles/${id}`;
}

export function searchLink(appOrigin: string, query: string, scope: SearchScope): string {
  const params = new URLSearchParams({ q: query });
  if (scope !== "all") params.set("scope", scope);
  return `${appOrigin}/search?${params.toString()}`;
}

function clip(text: string, max: number): string {
  return truncateChars(text, max - 1);
}

/**
 * Hits stay whole and bold; the prose around them is cut from the side away from the nearest
 * hit, the same rule the site's snippet uses, so the card never hides why a row matched.
 */
export function snippetMarkdown(segments: readonly SnippetSegment[], budget = 60): string {
  const runs = segments
    .map((segment) => ({ text: segment.text.replace(/\s+/gu, " "), hit: segment.hit }))
    .filter((segment) => segment.hit || segment.text.length > 0);
  return runs
    .map((segment, index) => {
      if (segment.hit) return `**${md(segment.text)}**`;
      let text = segment.text;
      if (text.length > budget) {
        if (index === 0) text = `…${text.slice(-budget)}`;
        else if (index === runs.length - 1) text = `${text.slice(0, budget)}…`;
        else text = `${text.slice(0, budget / 2)}…${text.slice(-budget / 2)}`;
      }
      return md(text);
    })
    .join("")
    .trim();
}

function metaLine(article: ArticleSummary): string {
  const parts = [
    article.author ? md(article.author) : null,
    article.publishedAt ? hongKongDay(article.publishedAt) : null,
    ...article.tags.slice(0, 2).map((tag) => md(tag.split("/").at(-1) ?? tag)),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `<font color='grey'>${parts.join(" · ")}</font>` : "";
}

function hitElement(hit: SearchHit, number: number, appOrigin: string): CardElement {
  const lines = [
    `**${number}. ${link(hit.title, articleLink(appOrigin, hit.id))}**`,
    metaLine(hit),
    hit.snippet?.length
      ? snippetMarkdown(hit.snippet)
      : hit.excerpt
        ? md(clip(hit.excerpt, 120))
        : "",
  ].filter(Boolean);
  return markdown(lines.join("\n"));
}

export interface SearchView {
  readonly query: string;
  readonly scope: SearchScope;
  /** Cursors that produced this page; empty on the first page. */
  readonly trail: readonly string[];
  readonly chatType: "p2p" | "group";
  readonly page: SearchPage;
  readonly appOrigin: string;
  /** Fresh per render; stamps the page's buttons. */
  readonly nonce: string;
}

function pageButtons(view: SearchView): CardElement | null {
  const base: Omit<SearchAction, "trail"> = {
    v: 1,
    cmd: "search",
    q: view.query,
    scope: view.scope,
    chatType: view.chatType,
    nonce: view.nonce,
  };
  const buttons: CardElement[] = [];
  if (view.trail.length > 0) {
    buttons.push(callbackButton("上一页", { ...base, trail: view.trail.slice(0, -1) }));
  }
  if (view.page.nextCursor) {
    buttons.push(
      callbackButton(
        "下一页",
        { ...base, trail: [...view.trail, view.page.nextCursor] },
        { primary: true },
      ),
    );
  }
  buttons.push(linkButton("在网站中打开", searchLink(view.appOrigin, view.query, view.scope)));
  return buttonRow(...buttons);
}

export function presentSearch(view: SearchView): FrozenPayload {
  const pageNo = view.trail.length + 1;
  const subtitle = `${SCOPE_LABEL[view.scope]} · 第 ${pageNo} 页`;
  const buttons = pageButtons(view);
  if (view.page.items.length === 0) {
    const elements: CardElement[] = [
      markdown(pageNo === 1 ? "没有找到匹配的文章。" : "这一页没有更多结果了。"),
      note(
        view.scope === "all"
          ? "试试更短或不同的关键词；/title 只搜标题，/kb 搜知识库。"
          : "试试 /search 在全文中查找。",
      ),
    ];
    if (buttons) elements.push(buttons);
    return freezeCard(
      card(`搜索：${clip(view.query, 40)}`, elements, { template: "orange", subtitle }),
    );
  }
  const elements: CardElement[] = [];
  // Numbering continues across pages, so page 2 starts at 6, not 1.
  const first = (pageNo - 1) * SEARCH_PAGE_SIZE + 1;
  view.page.items.forEach((hit, index) => {
    if (index > 0) elements.push(hr());
    elements.push(hitElement(hit, first + index, view.appOrigin));
  });
  elements.push(hr());
  if (buttons) elements.push(buttons);
  elements.push(
    note(
      `匹配词：${view.page.terms.map(md).join("、")} · 每页 ${SEARCH_PAGE_SIZE} 条，与网站排序一致`,
    ),
  );
  return freezeCard(card(`搜索：${clip(view.query, 40)}`, elements, { subtitle }));
}

export function presentHelp(chatType: "p2p" | "group"): FrozenPayload {
  const lines = COMMANDS.map((spec) => `**${spec.usage}**  ${spec.summary}`);
  const hint =
    chatType === "group"
      ? "群聊中先 @机器人 再发送命令；「搜索 关键词」同样有效。"
      : "私聊中直接发送关键词即可全文搜索；也可以点击输入框旁的机器人菜单。";
  return freezeCard(
    card("RM 文库机器人", [markdown(lines.join("\n")), hr(), note(hint)], {
      subtitle: "命令列表",
    }),
  );
}

export function presentUnknown(name: string): FrozenPayload {
  return freezeCard(errorCard("未知命令", `\`/${md(name)}\` 不是可用命令。`, HELP_HINT));
}

export function presentInvalid(reason: "empty" | "too_long"): FrozenPayload {
  return freezeCard(
    reason === "too_long"
      ? errorCard("关键词太长", "搜索词不能超过 200 个字符。", HELP_HINT)
      : errorCard(
          "缺少关键词",
          "请在命令后面输入要搜索的关键词，例如 `/search 云台 PID`。",
          HELP_HINT,
        ),
  );
}

export function presentLatest(items: readonly ArticleSummary[], appOrigin: string): FrozenPayload {
  const elements: CardElement[] = [];
  items.forEach((article, index) => {
    if (index > 0) elements.push(hr());
    const lines = [
      `**${index + 1}. ${link(article.title, articleLink(appOrigin, article.id))}**`,
      metaLine(article),
      article.tldr
        ? md(clip(article.tldr, 120))
        : article.excerpt
          ? md(clip(article.excerpt, 120))
          : "",
    ].filter(Boolean);
    elements.push(markdown(lines.join("\n")));
  });
  if (items.length === 0) elements.push(markdown("文库还没有收录文章。"));
  elements.push(hr(), buttonRow(linkButton("打开文库", appOrigin, { primary: true })));
  return freezeCard(card("最新文章", elements, { template: "green", subtitle: "按发布时间" }));
}

export function presentStatus(status: LibraryStatus, appOrigin: string): FrozenPayload {
  const rows: (readonly [string, string])[] = [
    ["已收录", `${status.articles.fetched} / ${status.articles.total} 篇`],
    ["标签", `${status.articles.tags}`],
    ["AI 摘要", `${status.ai.ready} 篇就绪，${status.ai.missing} 篇待处理`],
    ["知识库实体", `${status.ai.entities}`],
  ];
  return freezeCard(
    card(
      md(status.site.name),
      [kvTable(rows), hr(), buttonRow(linkButton("状态页", `${appOrigin}/status`))],
      { template: "indigo", subtitle: "收录情况" },
    ),
  );
}

export function presentArticle(article: ArticleSnapshot): FrozenPayload {
  const elements: CardElement[] = [markdown(`**${link(article.title, article.articleLink)}**`)];
  if (article.excerpt) elements.push(markdown(md(clip(article.excerpt, 200))));
  elements.push(buttonRow(linkButton("阅读全文", article.articleLink, { primary: true })));
  return freezeCard(card("RM 文库新文章", elements, { template: "green" }));
}

export function presentDigest(day: string, articles: readonly ArticleSnapshot[]): FrozenPayload {
  const lines = articles.map((article, index) => {
    const head = `${index + 1}. ${link(article.title, article.articleLink)}`;
    return article.excerpt
      ? `${head}\n<font color='grey'>${md(clip(article.excerpt, 80))}</font>`
      : head;
  });
  return freezeCard(
    card(`${day} 新文章汇总`, [markdown(lines.join("\n")), note(`共 ${articles.length} 篇`)], {
      template: "blue",
      subtitle: "RM 文库",
    }),
  );
}
