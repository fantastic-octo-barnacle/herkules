import { createHash } from "node:crypto";

import type { SearchHit } from "../library/index.ts";

export interface ArticleSnapshot {
  readonly title: string;
  readonly excerpt: string | null;
  readonly articleLink: string;
}

export interface FrozenPayload {
  readonly msgType: "text";
  readonly content: string;
  readonly hash: string;
}

function freezeText(text: string): FrozenPayload {
  const content = JSON.stringify({ text });
  return {
    msgType: "text",
    content,
    hash: createHash("sha256").update(`text\0${content}`).digest("hex"),
  };
}

export function presentArticle(article: ArticleSnapshot): FrozenPayload {
  const lines = ["RM 文库新文章", article.title];
  if (article.excerpt) lines.push(article.excerpt);
  lines.push(article.articleLink);
  return freezeText(lines.join("\n"));
}

export function presentDigest(day: string, articles: readonly ArticleSnapshot[]): FrozenPayload {
  const entries = articles.map((article, index) => {
    const lines = [`${index + 1}. ${article.title}`];
    if (article.excerpt) lines.push(article.excerpt);
    lines.push(article.articleLink);
    return lines.join("\n");
  });
  return freezeText([`RM 文库 ${day} 新文章汇总`, ...entries].join("\n\n"));
}

export function presentHelp(): FrozenPayload {
  return freezeText(
    "搜索 RM 文库：\n• 群聊中 @机器人 后发送“搜索 关键词”或“search 关键词”\n• 私聊中直接发送关键词\n• 每次返回最多 5 条结果",
  );
}

export function presentInvalid(reason: "empty" | "too_long"): FrozenPayload {
  return freezeText(
    reason === "too_long" ? "搜索词不能超过 200 个字符。" : "请在“搜索”后输入关键词。",
  );
}

export function presentSearch(
  query: string,
  hits: readonly SearchHit[],
  appOrigin: string,
): FrozenPayload {
  if (hits.length === 0) return freezeText(`没有找到与“${query}”匹配的文章。`);
  const entries = hits.map((hit, index) => {
    const lines = [`${index + 1}. ${hit.title}`];
    if (hit.excerpt) lines.push(hit.excerpt);
    lines.push(`${appOrigin}/articles/${hit.id}`);
    return lines.join("\n");
  });
  return freezeText([`“${query}”的搜索结果`, ...entries].join("\n\n"));
}
