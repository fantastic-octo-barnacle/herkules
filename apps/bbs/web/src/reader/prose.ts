/**
 * Reader post-processing of the article body. The input is round 1's SANITISED
 * HTML (content/render.ts): attribute values are entity-escaped, so `>` never
 * occurs inside a tag and a regex pass is sufficient — the SPA ships no DOM
 * parser — see web/README.md §"Decisions that bind". Every value these passes
 * insert is escaped here, because that is the only untrusted thing they add.
 */
import type { ArticleDTO } from "../../../src/api/dto.ts";

export interface Heading {
  readonly id: string;
  readonly level: 2 | 3;
  readonly text: string;
}

export interface PreparedProse {
  readonly html: string;
  readonly headings: readonly Heading[];
  /** A leading `<h1>` lifted out of the body; the page shows it as a deck line. */
  readonly deck: string | null;
}

const HEADING = /<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Tag-stripped, entity-decoded, whitespace-collapsed text of a heading. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** For values we put INTO an attribute or a text node of our own making. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `bodyText` fallback for rows with no `contentHtml` (skipped imports). */
function paragraphs(bodyText: string): string {
  return bodyText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Fill an empty `alt` from the article's image list, which already falls back
 * to the AI caption server-side — the consumer cannot tell the two apart.
 * An image that carries its own alt is left alone.
 */
export function withImageAlts(html: string, images: ArticleDTO["images"]): string {
  const byUrl = new Map(images.filter((i) => i.alt).map((i) => [i.url, i.alt as string]));
  if (byUrl.size === 0) return html;
  return html.replace(/<img\b([^>]*)>/g, (tag, attrs: string) => {
    const src = /\bsrc="([^"]*)"/.exec(attrs)?.[1];
    if (!src) return tag;
    let alt = byUrl.get(src);
    if (alt === undefined) {
      // The sanitiser may have percent-encoded a CDN path the DTO carries raw.
      try {
        alt = byUrl.get(decodeURI(src));
      } catch {
        alt = undefined;
      }
    }
    if (!alt) return tag;
    if (/\balt="[^"]+"/.test(attrs)) return tag;
    const escaped = escapeHtml(alt);
    const cleaned = attrs.replace(/\s*\balt=""/g, "");
    return `<img${cleaned} alt="${escaped}" title="${escaped}">`;
  });
}

/**
 * Point links whose target is in this library at the local reader. Only the
 * `href` VALUE changes: rm-wenku's pass rewrote the whole tag and so dropped
 * `rel`/`class`/`target`, which cost the sanitiser's `noopener` on any link it
 * later decided was external again.
 */
export function withLocalLinks(html: string, links: ArticleDTO["links"]): string {
  const byUrl = new Map(
    links.filter((l) => l.articleId).map((l) => [l.url, l.articleId as string]),
  );
  if (byUrl.size === 0) return html;
  return html.replace(/<a\b([^>]*)>/g, (tag: string, attrs: string) => {
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
    if (!href) return tag;
    const id = byUrl.get(href) ?? byUrl.get(href.replace(/\/$/, ""));
    if (!id) return tag;
    const rewritten = attrs.replace(/\bhref="[^"]*"/, `href="/articles/${escapeHtml(id)}"`);
    return `<a${rewritten}>`;
  });
}

/**
 * Forum posts often open with an `<h1>` carrying the real title (the listing
 * title follows the 【RM2026-主题】队伍 convention instead). Lift it out so the
 * page shows one headline, not two.
 */
export function extractLeadHeading(html: string): { html: string; deck: string | null } {
  const match = html.match(/^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>\s*/);
  if (!match) return { html, deck: null };
  const deck = plain(match[1] ?? "");
  return deck ? { html: html.slice(match[0].length), deck } : { html, deck: null };
}

/** `id="sec-N"` on every non-empty h2/h3, in document order — the TOC's anchors. */
export function withHeadingIds(html: string): { html: string; headings: readonly Heading[] } {
  const headings: Heading[] = [];
  const out = html.replace(
    HEADING,
    (match: string, level: string, attrs: string | undefined, inner: string) => {
      const text = plain(inner);
      if (!text) return match; // an empty heading is a spacer, not a section
      const id = `sec-${headings.length + 1}`;
      headings.push({ id, level: level === "2" ? 2 : 3, text });
      return `<h${level} id="${id}"${attrs ?? ""}>${inner}</h${level}>`;
    },
  );
  return { html: out, headings };
}

/** The reader's single entry point: the four passes in the order they compose. */
export function prepareProse(
  article: Pick<ArticleDTO, "contentHtml" | "bodyText" | "images" | "links">,
): PreparedProse {
  const source = article.contentHtml ?? (article.bodyText ? paragraphs(article.bodyText) : "");
  const linked = withLocalLinks(withImageAlts(source, article.images), article.links);
  const lead = extractLeadHeading(linked);
  const { html, headings } = withHeadingIds(lead.html);
  return { html, headings, deck: lead.deck };
}
