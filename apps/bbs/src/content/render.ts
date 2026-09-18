/**
 * `content_raw` -> sanitised `content_html`. A port of rm-wenku's
 * `wenku-core/src/render.rs` + `style.rs` (pulldown-cmark + ammonia) to
 * markdown-it + sanitize-html, run ONCE per article at import time.
 *
 * THIS IS A SECURITY BOUNDARY. Its output is injected into the reader with
 * `dangerouslySetInnerHTML` and nothing downstream sanitises again. A permissive
 * port here is an XSS in the archive, so: the allowlist is written out
 * explicitly (`ALLOWED` — ammonia's defaults plus rm-wenku's additions), never
 * inherited from sanitize-html's default; and it has its own test file with the
 * adversarial cases (`<script>`, `javascript:` hrefs, `onerror`, `<iframe>` to a
 * non-allowlisted host, `style` outside the allowlist, `data:` images).
 *
 * Pipeline, in the Rust order:
 *  1. markdown sources -> HTML via markdown-it (tables, strikethrough, task lists; `html: false`).
 *     HTML sources: rewrite WangEditor `[n]` reference markers into anchors labelled by the
 *     referenced link, and reduce every `<iframe>` that is not a known video player to a link.
 *  2. sanitise against ALLOWED, resolving every `src`/`href`/`poster`/`cite` against the
 *     article's canonical URL (the corpus hot-links the forum CDN and stores nothing locally).
 *     Forced attributes, verbatim from ammonia's configuration:
 *       a      target="_blank" rel="noopener noreferrer nofollow"
 *       img    loading="lazy" referrerpolicy="no-referrer"
 *       video  controls preload="metadata" playsinline
 *       iframe allowfullscreen loading="lazy", only when `isEmbedUrl(src)`
 *       input  only type="checkbox"; disabled
 *       code   class ~ /^language-/ only
 *     MathML passes; inline `style` is filtered to a property allowlist (`filterStyle`).
 *  3. strip a leading `<h1>` that duplicates the title.
 *
 * RENDER_VERSION is bumped on ANY change to this file or its allowlists; the
 * import records it and treats a differing version as "must reload" even when
 * source digests match.
 */
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

import { referenceTarget } from "./urls.ts";

export const RENDER_VERSION = "1";

export interface RenderLink {
  readonly url: string;
  readonly label: string | null;
}

export interface RenderInput {
  readonly format: "html" | "markdown";
  readonly raw: string;
  /** canonical_url; relative URLs resolve against it. */
  readonly baseUrl: string;
  /** Used only to strip a duplicate leading `<h1>`. */
  readonly title: string;
  /** `[n]` reference markers resolve against these, in `position` order. */
  readonly links: readonly RenderLink[];
}

// ── the allowlist ───────────────────────────────────────────────────────────

const MATH_TAGS = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mo",
  "mn",
  "mtext",
  "ms",
  "mspace",
  "msub",
  "msup",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "mtable",
  "mtr",
  "mtd",
  "mover",
  "munder",
  "munderover",
  "mpadded",
  "mphantom",
  "menclose",
  "merror",
  "mmultiscripts",
  "mprescripts",
  "none",
] as const;

const MATH_ATTRS = [
  "xmlns",
  "display",
  "mathvariant",
  "mathsize",
  "mathcolor",
  "displaystyle",
  "scriptlevel",
  "stretchy",
  "fence",
  "separator",
  "form",
  "lspace",
  "rspace",
  "symmetric",
  "largeop",
  "movablelimits",
  "accent",
  "accentunder",
  "linethickness",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "columnlines",
  "rowlines",
  "frame",
  "width",
  "height",
  "depth",
  "voffset",
  "lquote",
  "rquote",
  "notation",
  "encoding",
  "open",
  "close",
  "separators",
  "minsize",
  "maxsize",
] as const;

/** ammonia's default tag set (the Rust sanitiser's baseline), spelled out. */
const AMMONIA_TAGS = [
  "a",
  "abbr",
  "acronym",
  "area",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "map",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
] as const;

const tableAlign = ["align", "char", "charoff"] as const;

/** ammonia's per-tag attributes plus rm-wenku's additions and the forced attributes it sets. */
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "hreflang", "target", "rel"],
  bdo: ["dir"],
  blockquote: ["cite"],
  col: [...tableAlign, "span"],
  colgroup: [...tableAlign, "span"],
  del: ["cite", "datetime"],
  hr: ["align", "size", "width"],
  img: ["align", "alt", "height", "src", "width", "loading", "referrerpolicy"],
  ins: ["cite", "datetime"],
  ol: ["start"],
  q: ["cite"],
  table: [...tableAlign, "summary"],
  tbody: [...tableAlign],
  td: [...tableAlign, "colspan", "headers", "rowspan"],
  tfoot: [...tableAlign],
  th: [...tableAlign, "colspan", "headers", "rowspan", "scope"],
  thead: [...tableAlign],
  tr: [...tableAlign],
  video: ["src", "poster", "width", "height", "preload", "controls", "playsinline"],
  source: ["src", "type"],
  iframe: ["src", "width", "height", "allowfullscreen", "loading"],
  input: ["type", "checked", "disabled"],
  ...Object.fromEntries(MATH_TAGS.map((t) => [t, MATH_ATTRS])),
};

/** ammonia's default URL schemes. */
const URL_SCHEMES = [
  "bitcoin",
  "ftp",
  "ftps",
  "geo",
  "http",
  "https",
  "im",
  "irc",
  "ircs",
  "magnet",
  "mailto",
  "mms",
  "mx",
  "news",
  "nntp",
  "openpgp4fpr",
  "sip",
  "sms",
  "smsto",
  "ssh",
  "tel",
  "url",
  "webcal",
  "wtai",
  "xmpp",
] as const;

/** Video embeds are kept only for known players; any other `<iframe>` becomes a plain link. */
const EMBED_HOSTS = ["player.bilibili.com", "www.youtube.com", "www.youtube-nocookie.com"] as const;

/** The allowlist, exported so the test can assert on it rather than on rendered output alone. */
export const ALLOWED = {
  tags: [...AMMONIA_TAGS, "video", "source", "iframe", "input", ...MATH_TAGS] as readonly string[],
  attributes: TAG_ATTRIBUTES,
  /** Generic (every tag): ammonia's `lang`/`title` plus the filtered `style`. */
  genericAttributes: ["lang", "title", "style"] as readonly string[],
  styleProperties: [
    "text-align",
    "text-indent",
    "font-weight",
    "font-style",
    "text-decoration",
    "text-decoration-line",
    "font-size",
    "vertical-align",
    "white-space",
    "width",
    "max-width",
    "height",
    "color",
    "background-color",
  ] as readonly string[],
  embedHosts: EMBED_HOSTS as readonly string[],
  schemes: URL_SCHEMES as readonly string[],
} as const;

// ── the pipeline ────────────────────────────────────────────────────────────

const markdown = new MarkdownIt("default", { html: false, linkify: false, typographer: false });

/** Pure: (format, raw, base URL, title, links) -> sanitised HTML. */
export function renderArticleHtml(input: RenderInput): string {
  const source =
    input.format === "markdown"
      ? renderMarkdown(input.raw)
      : rewriteEmbeds(rewriteReferences(input.raw, input.links));
  return stripTitleHeading(sanitize(source, input.baseUrl), input.title);
}

/** markdown-it (tables and strikethrough are in the default preset) plus GFM task-list checkboxes. */
function renderMarkdown(raw: string): string {
  return markdown
    .render(raw)
    .replace(
      /<li>(<p>)?\[( |x|X)\] /g,
      (_m, p: string | undefined, mark: string) =>
        `<li>${p ?? ""}<input type="checkbox"${mark === " " ? "" : " checked"} disabled />`,
    );
}

/** `<span data-w-e-type="reference" data-link="…/{postId}/{n}">[n]</span>` -> `<a href="https://bbs.robomaster.com/article/{postId}">[n] label</a>`. */
export function rewriteReferences(html: string, links: readonly RenderLink[]): string {
  if (!html.includes('data-w-e-type="reference"')) return html;
  const marker = /<span\b([^>]*\bdata-w-e-type="reference"[^>]*)>([^<]*)<\/span>/g;
  const target = /\bdata-link="(bbs:\/\/reference\.com\/[^"]*?\/(\d+))"/;
  const postUrl = /^https?:\/\/bbs\.robomaster\.com\/article\/(\d+)(?:[/?#]|$)/;
  return html.replace(marker, (_m, attrs: string, inner: string) => {
    const text = inner.trim();
    const t = target.exec(attrs);
    const url = t ? referenceTarget(t[1]!) : null;
    if (!t || !url) return text;
    const order = t[2]!;
    const label = text === "" ? `[${order}]` : text;
    // The reference list may carry the same post with a query string (`?source=1`): match on the post id.
    const postId = url.slice(url.lastIndexOf("/") + 1);
    const link = links.find((l) => postUrl.exec(l.url)?.[1] === postId);
    const title = link?.label ? ` ${escapeText(link.label)}` : "";
    return `<a href="${url}">${label}${title}</a>`;
  });
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Allowlisted video hosts (bilibili, youtube) over https only; everything else is dropped by sanitize. */
export function isEmbedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" && (EMBED_HOSTS as readonly string[]).includes(parsed.hostname)
  );
}

/** Turn `<iframe>`s pointing anywhere but a known video player into links, so nothing silently disappears. */
export function rewriteEmbeds(html: string): string {
  if (!html.toLowerCase().includes("<iframe")) return html;
  return html.replace(
    /<iframe\b((?:"[^"]*"|'[^']*'|[^>"'])*)>(?:\s*<\/iframe>)?/gis,
    (whole, attrs: string) => {
      const src = /\bsrc\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
      if (src === undefined) return "";
      return isEmbedUrl(src.replaceAll("&amp;", "&"))
        ? whole
        : `<p><a href="${src}">${src}</a></p>`;
    },
  );
}

const URL_ATTRIBUTES = ["href", "src", "poster", "cite"] as const;

export function sanitize(html: string, baseUrl: string): string {
  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  const resolve = (value: string): string => {
    if (!base) return value;
    try {
      return new URL(value, base).href;
    } catch {
      return value;
    }
  };

  const every: sanitizeHtml.Transformer = (tagName, attribs) => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(attribs)) {
      if (name === "style") {
        const kept = filterStyle(tagName, value);
        if (kept !== null) out.style = kept;
        continue;
      }
      if ((name === "width" || name === "height") && value.trim() === "auto") continue;
      // An empty poster would otherwise resolve to the article URL.
      if (name === "poster" && value.trim() === "") continue;
      if ((URL_ATTRIBUTES as readonly string[]).includes(name)) {
        if (tagName === "iframe" && name === "src" && !isEmbedUrl(value)) continue;
        out[name] = resolve(value);
        continue;
      }
      out[name] = value;
    }
    switch (tagName) {
      case "a":
        out.target = "_blank";
        out.rel = "noopener noreferrer nofollow";
        break;
      case "img":
        out.loading = "lazy";
        out.referrerpolicy = "no-referrer";
        break;
      case "video":
        out.controls = "";
        out.preload = "metadata";
        out.playsinline = "";
        break;
      case "iframe":
        out.allowfullscreen = "";
        out.loading = "lazy";
        break;
      case "input":
        if (out.type !== undefined && out.type.trim().toLowerCase() !== "checkbox") delete out.type;
        out.disabled = "";
        break;
    }
    return { tagName, attribs: out };
  };

  return sanitizeHtml(html, {
    allowedTags: [...ALLOWED.tags],
    allowedAttributes: {
      "*": [...ALLOWED.genericAttributes],
      ...Object.fromEntries(Object.entries(TAG_ATTRIBUTES).map(([t, a]) => [t, [...a]])),
    },
    allowedClasses: { code: [/^language-/] },
    allowedSchemes: [...URL_SCHEMES],
    allowedSchemesAppliedToAttributes: [...URL_ATTRIBUTES],
    allowProtocolRelative: false,
    allowedIframeHostnames: [...EMBED_HOSTS],
    allowIframeRelativeUrls: false,
    // `style` is filtered by `filterStyle` inside the transform, not by sanitize-html's CSS parser.
    parseStyleAttributes: false,
    transformTags: Object.fromEntries(ALLOWED.tags.map((t) => [t, every])),
  });
}

/** Collapse all runs of whitespace into single spaces and trim the ends (rm-wenku `clean_text`). */
function cleanText(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

/** Drop a leading `<h1>` whose text equals `title` after whitespace normalisation. */
export function stripTitleHeading(html: string, title: string): string {
  const trimmed = html.trimStart();
  if (!trimmed.startsWith("<h1")) return html;
  const afterTag = trimmed.slice(3);
  // `<h1>` or `<h1 …>`, never `<h10>`/`<h1x>`.
  if (!afterTag.startsWith(">") && !/^\s/.test(afterTag)) return html;
  const close = afterTag.indexOf(">");
  if (close < 0) return html;
  const rest = afterTag.slice(close + 1);
  const end = rest.indexOf("</h1>");
  if (end < 0) return html;
  const heading = cleanText(rest.slice(0, end).replace(/<[^>]*>/g, ""));
  if (heading.toLowerCase() !== cleanText(title).toLowerCase()) return html;
  return rest.slice(end + "</h1>".length).trimStart();
}

// ── inline styles (style.rs) ────────────────────────────────────────────────

const LENGTH_UNITS = ["px", "em", "rem", "%", "pt"] as const;
const SIZED_ELEMENTS = ["img", "video", "iframe", "table", "td", "th", "col"] as const;
/** Fixed heights fight the reader's responsive rules, so only players keep them. */
const HEIGHT_ELEMENTS = ["video", "iframe"] as const;
const NAMED_CHROMATIC = new Set([
  "red",
  "blue",
  "green",
  "orange",
  "purple",
  "yellow",
  "pink",
  "brown",
  "teal",
  "navy",
  "maroon",
  "olive",
  "gold",
  "crimson",
  "tomato",
  "coral",
  "orangered",
  "darkred",
  "darkblue",
  "darkgreen",
  "royalblue",
  "dodgerblue",
  "steelblue",
  "skyblue",
  "deepskyblue",
  "seagreen",
  "limegreen",
  "lime",
  "magenta",
  "fuchsia",
  "violet",
  "indigo",
  "salmon",
  "khaki",
  "chocolate",
  "firebrick",
  "goldenrod",
  "darkorange",
]);

/**
 * Filter one `style` attribute on `element`. The editor writes its own defaults
 * (`color: rgb(0,0,0)`, white backgrounds, `line-height: 1.5`); the author's
 * intent (centred captions, coloured warnings, sized images) is what survives.
 * Colours are kept only when chromatic — neutral blacks/greys/whites would be
 * invisible on the reader's dark theme. Returns null when nothing survives.
 */
export function filterStyle(element: string, css: string): string | null {
  const kept: string[] = [];
  let explicitColor = false;
  let background: Rgb | null = null;

  for (const declaration of css.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    let value = declaration.slice(colon + 1).trim();
    if (value.endsWith("!important")) value = value.slice(0, -"!important".length).trim();
    if (value === "" || !isSafeValue(value)) continue;
    value = value.toLowerCase();
    let keep: boolean;
    switch (property) {
      case "text-align":
        keep = ["left", "center", "right", "justify"].includes(value);
        break;
      case "text-indent":
        keep = isLength(value);
        break;
      case "font-weight":
        keep = ["bold", "bolder", "normal", "lighter"].includes(value) || /^\d{3}$/.test(value);
        break;
      case "font-style":
        keep = ["italic", "oblique", "normal"].includes(value);
        break;
      case "text-decoration":
      case "text-decoration-line":
        keep = value
          .split(/\s+/)
          .every((w) => ["underline", "line-through", "overline", "none"].includes(w));
        break;
      case "font-size":
        keep = isFontSize(value);
        break;
      case "vertical-align":
        keep = [
          "baseline",
          "sub",
          "super",
          "top",
          "middle",
          "bottom",
          "text-top",
          "text-bottom",
        ].includes(value);
        break;
      case "white-space":
        keep = ["normal", "nowrap", "pre", "pre-wrap"].includes(value);
        break;
      case "width":
      case "max-width":
        keep =
          (SIZED_ELEMENTS as readonly string[]).includes(element) &&
          (value === "auto" || isLength(value));
        break;
      case "height":
        keep = (HEIGHT_ELEMENTS as readonly string[]).includes(element) && isLength(value);
        break;
      case "color": {
        const rgb = parseColor(value);
        keep = rgb !== null && isChromatic(rgb);
        if (keep) explicitColor = true;
        break;
      }
      case "background-color": {
        const rgb = parseColor(value);
        keep = rgb !== null && isChromatic(rgb);
        if (keep) background = rgb;
        break;
      }
      default:
        keep = false;
    }
    if (keep) kept.push(`${property}: ${value}`);
  }

  // A coloured background needs a text colour that works on it regardless of the reader's theme.
  if (background !== null && !explicitColor) {
    kept.push(isLight(background) ? "color: #1c2433" : "color: #f2f4f7");
  }
  return kept.length === 0 ? null : kept.join("; ");
}

function isSafeValue(value: string): boolean {
  const lower = value.toLowerCase();
  return !(
    lower.includes("url(") ||
    lower.includes("expression") ||
    lower.includes("javascript") ||
    lower.includes("var(") ||
    lower.includes("\\") ||
    lower.includes("/*") ||
    lower.includes("<") ||
    lower.includes(">") ||
    lower.includes("@")
  );
}

function isLength(value: string): boolean {
  if (value === "0") return true;
  return LENGTH_UNITS.some((unit) => {
    if (!value.endsWith(unit)) return false;
    const n = value.slice(0, -unit.length);
    return n !== "" && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(n) && Number(n) >= 0;
  });
}

/** Sizes between small print and a display heading; anything else is the editor's default or nonsense. */
function isFontSize(value: string): boolean {
  let px: number | null = null;
  if (value.endsWith("px")) px = numberOrNull(value.slice(0, -2));
  else if (value.endsWith("rem")) px = scale(numberOrNull(value.slice(0, -3)));
  else if (value.endsWith("em")) px = scale(numberOrNull(value.slice(0, -2)));
  return px !== null && px >= 11 && px <= 40;
}

function scale(n: number | null): number | null {
  return n === null ? null : n * 16;
}

function numberOrNull(s: string): number | null {
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : null;
}

type Rgb = readonly [number, number, number];

/** Neutral greys have channels within a narrow band of each other. */
function isChromatic([r, g, b]: Rgb): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) >= 40;
}

function isLight([r, g, b]: Rgb): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

function parseColor(value: string): Rgb | null {
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const d = hex.split("").map((c) => Number.parseInt(c, 16));
    switch (d.length) {
      case 3:
      case 4:
        return [d[0]! * 17, d[1]! * 17, d[2]! * 17];
      case 6:
      case 8:
        if (d.length === 8 && d[6]! * 16 + d[7]! < 25) return null;
        return [d[0]! * 16 + d[1]!, d[2]! * 16 + d[3]!, d[4]! * 16 + d[5]!];
      default:
        return null;
    }
  }
  const fn = value.startsWith("rgba(") ? "rgba(" : value.startsWith("rgb(") ? "rgb(" : null;
  if (fn && value.endsWith(")")) {
    const parts = value
      .slice(fn.length, -1)
      .split(/[,/ ]/)
      .filter((p) => p !== "");
    if (parts.length < 3) return null;
    const channel = (s: string): number | null =>
      s.endsWith("%") ? scalePct(numberOrNull(s.slice(0, -1))) : numberOrNull(s);
    const alphaRaw = parts[3];
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith("%")
          ? (numberOrNull(alphaRaw.slice(0, -1)) ?? 100) / 100
          : (numberOrNull(alphaRaw) ?? 1);
    if (alpha < 0.1) return null;
    const r = channel(parts[0]!);
    const g = channel(parts[1]!);
    const b = channel(parts[2]!);
    return r === null || g === null || b === null ? null : [r, g, b];
  }
  // Named colours: keep the obviously chromatic ones, drop black/white/grey and everything exotic.
  return NAMED_CHROMATIC.has(value) ? [255, 0, 0] : null;
}

function scalePct(n: number | null): number | null {
  return n === null ? null : n * 2.55;
}
