/**
 * wenku-core extract/{mod,html,markdown}.rs: raw article body -> normalised
 * plain text plus the outbound links and images it mentions.
 *
 * One accumulator serves both walks, so a source can keep appending after the
 * body has been processed (the forum hands us attachments, fileItems and a
 * titled reference list separately) and every URL goes through the same
 * resolve/normalise/dedupe rules as one found in the content.
 *
 * Parsers differ from Rust (htmlparser2 for scraper/html5ever, markdown-it for
 * pulldown-cmark), so `bodyText` may differ from rm-wenku's in whitespace-level
 * detail. The invariants on the links/images tables are what import depends on,
 * and those are held exactly.
 */
import { DomUtils, parseDocument } from "htmlparser2";
import MarkdownIt from "markdown-it";

import { cleanText, countChars } from "./text.ts";
import { classifyLink, type LinkKind, referenceTarget, resolveAndNormalize } from "./urls.ts";

/** Bumped whenever a change here would give a re-import a different body_text. */
export const EXTRACT_VERSION = "0";

export interface ExtractedLink {
  readonly url: string;
  readonly kind: LinkKind;
  readonly label: string | null;
  readonly position: number;
}

export interface ExtractedImage {
  readonly url: string;
  readonly alt: string | null;
  readonly position: number;
}

export interface Extracted {
  readonly bodyText: string;
  readonly links: readonly ExtractedLink[];
  readonly images: readonly ExtractedImage[];
}

/** Resources a source knows about that the body never names (attachments, fileItems, references). */
export interface ExtractExtras {
  readonly links: readonly { url: string; label: string | null }[];
  readonly images: readonly { url: string; alt: string | null }[];
}

/**
 * INVARIANTS: links/images deduped by normalised URL (first wins; a later
 * label/alt is adopted only when the first had none); `position` dense from 0
 * in first-seen order; self-references (== baseUrl) and `#…`/`javascript:`/
 * `data:`/`.svg` dropped; every URL absolute http(s). Extras go through the
 * SAME add rules as in-content links.
 */
export function extract(
  format: "html" | "markdown",
  raw: string,
  baseUrl: string,
  extras?: ExtractExtras,
): Extracted {
  const out = new Accumulator(baseUrl);
  const bodyText = format === "html" ? runHtml(raw, out) : runMarkdown(raw, out);
  if (extras) {
    for (const link of extras.links) out.addLink(link.url, link.label);
    for (const image of extras.images) out.addImage(image.url, image.alt);
  }
  return { bodyText, links: out.links, images: out.images };
}

// ── the accumulator (Rust `Extracted::add_link` / `add_image`) ───────────────

interface MutableLink {
  url: string;
  kind: LinkKind;
  label: string | null;
  position: number;
}

interface MutableImage {
  url: string;
  alt: string | null;
  position: number;
}

/**
 * De-duplicates by normalised URL and hands out dense positions. Kept separate
 * from the walks so both formats — and a caller appending afterwards — obey one
 * rule set.
 */
class Accumulator {
  readonly links: MutableLink[] = [];
  readonly images: MutableImage[] = [];
  readonly baseUrl: string;
  /** The base as it would look after normalisation; a link equal to it is a self-reference. */
  readonly normalizedBase: string | null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.normalizedBase = resolveAndNormalize(baseUrl, baseUrl);
  }

  /** Add a link found in the article, resolved against the base. Duplicates, self-references and non-navigational schemes are ignored. */
  addLink(rawUrl: string, label: string | null): void {
    const raw = rawUrl.trim();
    if (raw === "" || raw.startsWith("#") || startsWithScheme(raw, "javascript:")) return;
    const url = resolveAndNormalize(this.baseUrl, raw);
    if (url === null || !url.startsWith("http")) return;
    if (this.normalizedBase !== null && this.normalizedBase === url) return;

    const cleaned = cleanLabel(label);
    const existing = this.links.find((link) => link.url === url);
    if (existing) {
      // The same target can arrive twice (body marker, then the source's
      // titled reference list); keep the first row but adopt a label.
      if (existing.label === null) existing.label = cleaned;
      return;
    }
    this.links.push({ url, kind: kindOf(url), label: cleaned, position: this.links.length });
  }

  /** Add an image found in the article, resolved against the base. Inline data URIs and SVGs are ignored. */
  addImage(rawUrl: string, alt: string | null): void {
    const raw = rawUrl.trim();
    if (raw === "" || startsWithScheme(raw, "data:") || isSvg(raw)) return;
    const url = resolveAndNormalize(this.baseUrl, raw);
    if (url === null || !url.startsWith("http")) return;
    if (this.images.some((image) => image.url === url)) return;
    this.images.push({ url, alt: cleanLabel(alt), position: this.images.length });
  }
}

function cleanLabel(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = cleanText(value);
  return cleaned === "" ? null : cleaned;
}

function kindOf(url: string): LinkKind {
  try {
    return classifyLink(new URL(url));
  } catch {
    return "other";
  }
}

/** Case-insensitive scheme prefix test. */
function startsWithScheme(value: string, scheme: string): boolean {
  return value.slice(0, scheme.length).toLowerCase() === scheme;
}

function isSvg(value: string): boolean {
  const path = value.split(/[?#]/)[0] ?? "";
  return path.toLowerCase().endsWith(".svg");
}

// ── the block writer ────────────────────────────────────────────────────────

/** Accumulates text blocks; consecutive duplicates and trivially short blocks are dropped. */
class BlockWriter {
  private readonly blocks: string[] = [];
  private current = "";
  private preformatted = 0;

  pushText(text: string): void {
    this.current += text;
  }

  enterPreformatted(): void {
    this.preformatted += 1;
  }

  leavePreformatted(): void {
    if (this.preformatted > 0) this.preformatted -= 1;
  }

  flush(): void {
    const block = this.preformatted > 0 ? trimPreformatted(this.current) : cleanText(this.current);
    this.current = "";
    if (countChars(block) <= 1) return;
    if (this.blocks[this.blocks.length - 1] === block) return;
    this.blocks.push(block);
  }

  finish(): string {
    this.flush();
    return this.blocks.join("\n\n");
  }
}

/** Inside `<pre>`/a fence, only trailing spaces per line and blank edges go. */
function trimPreformatted(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

// ── HTML ────────────────────────────────────────────────────────────────────

const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg"]);
/** The 37 HTML block-level elements that start and end a text block. */
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);
const CELL_ELEMENTS = new Set(["td", "th"]);

type DomNode = ReturnType<typeof parseDocument>["children"][number];

/**
 * Block boundaries follow HTML block-level elements so nested structures
 * (lists in lists, paragraphs in quotes) keep their own paragraphs instead of
 * being duplicated or merged.
 */
function runHtml(raw: string, out: Accumulator): string {
  const document = parseDocument(raw);
  const writer = new BlockWriter();
  walkHtmlChildren(document.children, writer);
  const bodyText = writer.finish();

  // Three document-order passes, as the Rust selectors ran: anchors, then the
  // editor's reference markers, then images.
  const anchors: DomNode[] = [];
  const references: DomNode[] = [];
  const images: DomNode[] = [];
  collect(document.children, anchors, references, images);

  for (const anchor of anchors) {
    if (!DomUtils.isTag(anchor)) continue;
    out.addLink(anchor.attribs["href"] ?? "", DomUtils.textContent(anchor));
  }
  for (const marker of references) {
    if (!DomUtils.isTag(marker)) continue;
    const target = referenceTarget(marker.attribs["data-link"] ?? "");
    if (target !== null) out.addLink(target, null);
  }
  for (const image of images) {
    if (!DomUtils.isTag(image)) continue;
    const attrs = image.attribs;
    const alt = attrs["alt"];
    const chosen = alt !== undefined && alt.trim() !== "" ? alt : (attrs["title"] ?? null);
    out.addImage(attrs["src"] ?? "", chosen);
  }
  return bodyText;
}

function collect(
  nodes: readonly DomNode[],
  anchors: DomNode[],
  references: DomNode[],
  images: DomNode[],
): void {
  for (const node of nodes) {
    if (DomUtils.isTag(node)) {
      const attrs = node.attribs;
      if (node.name === "a" && attrs["href"] !== undefined) anchors.push(node);
      if (attrs["data-w-e-type"] === "reference" && attrs["data-link"] !== undefined) {
        references.push(node);
      }
      if (node.name === "img" && attrs["src"] !== undefined) images.push(node);
    }
    if (DomUtils.hasChildren(node)) collect(node.children, anchors, references, images);
  }
}

function walkHtml(node: DomNode, writer: BlockWriter): void {
  if (DomUtils.isText(node)) {
    writer.pushText(node.data);
    return;
  }
  if (!DomUtils.isTag(node)) {
    if (DomUtils.hasChildren(node)) walkHtmlChildren(node.children, writer);
    return;
  }

  const name = node.name;
  if (SKIPPED_ELEMENTS.has(name)) return;
  const attrs = node.attribs;

  // The editor wraps every formula as
  // `<span data-w-e-type="mathLatex" data-content="LATEX"><span class="katex"><math>…`;
  // the MathML would read as garbled symbols, so emit the LaTeX once.
  const dataContent = attrs["data-content"];
  if (dataContent !== undefined && attrs["data-w-e-type"] === "mathLatex") {
    writer.pushText(` $${dataContent.trim()}$ `);
    return;
  }
  if (name === "math") {
    const tex = annotationText(node.children);
    if (tex !== null) writer.pushText(` $${tex}$ `);
    else walkHtmlChildren(node.children, writer);
    return;
  }
  if (name === "video" || name === "iframe") {
    const source = attrs["data-file-name"] ?? attrs["src"];
    const label = source === undefined ? "" : source.trim();
    if (label !== "") {
      writer.flush();
      writer.pushText(`（视频：${label}）`);
      writer.flush();
    }
    return;
  }

  const isBlock = BLOCK_ELEMENTS.has(name);
  const isPre = name === "pre";
  if (isBlock) writer.flush();
  if (isPre) writer.enterPreformatted();
  if (name === "br") writer.pushText("\n");
  walkHtmlChildren(node.children, writer);
  if (CELL_ELEMENTS.has(name)) writer.pushText(" ");
  // The flush happens while `pre` is still in force, exactly as in Rust.
  if (isBlock) writer.flush();
  if (isPre) writer.leavePreformatted();
}

function walkHtmlChildren(nodes: readonly DomNode[], writer: BlockWriter): void {
  for (const child of nodes) walkHtml(child, writer);
}

/** The TeX source a MathML `<annotation encoding="application/x-tex">` carries. */
function annotationText(nodes: readonly DomNode[]): string | null {
  const found = findAnnotation(nodes);
  if (found === null) return null;
  const tex = DomUtils.textContent(found).trim();
  return tex === "" ? null : tex;
}

function findAnnotation(nodes: readonly DomNode[]): DomNode | null {
  for (const node of nodes) {
    if (DomUtils.isTag(node) && node.name === "annotation") return node;
    if (DomUtils.hasChildren(node)) {
      const nested = findAnnotation(node.children);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// ── Markdown ────────────────────────────────────────────────────────────────

/**
 * `html: true` so raw and inline HTML reach us as tokens: the forum's markdown
 * posts carry `<img>`/`<a>` tags the renderer would otherwise be the only one
 * to see. The extractor never emits HTML, so this is not a sanitiser bypass.
 */
const markdown = new MarkdownIt("default", { html: true, linkify: false, typographer: false });

type Token = ReturnType<MarkdownIt["parse"]>[number];

const TASK_MARKER = /^\[[ xX]\] /u;

/** Blocks follow markdown blocks; embedded HTML is delegated to the HTML walk so its links survive. */
function runMarkdown(raw: string, out: Accumulator): string {
  const writer = new BlockWriter();
  const openLinks: { url: string; label: string }[] = [];
  let pendingTaskItem = false;

  const spliceHtml = (html: string): void => {
    const nested = new Accumulator(out.baseUrl);
    const bodyText = runHtml(html, nested);
    if (bodyText !== "") {
      writer.pushText(" ");
      writer.pushText(bodyText);
      writer.pushText(" ");
    }
    for (const link of nested.links) out.addLink(link.url, link.label);
    for (const image of nested.images) out.addImage(image.url, image.alt);
  };

  const pushInline = (text: string): void => {
    const open = openLinks[openLinks.length - 1];
    if (open) open.label += text;
    writer.pushText(text);
  };

  const walkInline = (children: readonly Token[]): void => {
    for (const token of children) {
      switch (token.type) {
        case "text":
        case "code_inline": {
          let text = token.content;
          if (pendingTaskItem) {
            // pulldown-cmark's ENABLE_TASKLISTS swallowed the marker; markdown-it
            // leaves it as literal text, so drop it here.
            text = text.replace(TASK_MARKER, "");
            pendingTaskItem = false;
          }
          pushInline(text);
          break;
        }
        case "softbreak":
          writer.pushText(" ");
          break;
        case "hardbreak":
          writer.pushText("\n");
          break;
        case "link_open":
          openLinks.push({ url: token.attrGet("href") ?? "", label: "" });
          break;
        case "link_close": {
          const open = openLinks.pop();
          if (open) out.addLink(open.url, open.label);
          break;
        }
        case "image":
          // The alt text is collected but deliberately NOT pushed to the body.
          out.addImage(token.attrGet("src") ?? "", collectText(token.children ?? []));
          break;
        case "html_inline":
          spliceHtml(token.content);
          break;
        default:
          // strong/em/s wrappers carry no text; footnote refs and math are dropped.
          break;
      }
      if (token.type !== "text" && token.type !== "code_inline") pendingTaskItem = false;
    }
  };

  for (const token of markdown.parse(raw, {})) {
    switch (token.type) {
      case "paragraph_open":
      case "paragraph_close":
      case "heading_open":
      case "heading_close":
      case "list_item_close":
      case "tr_open":
      case "tr_close":
      case "hr":
        writer.flush();
        break;
      case "list_item_open":
        writer.flush();
        pendingTaskItem = true;
        break;
      case "fence":
      case "code_block":
        writer.flush();
        writer.enterPreformatted();
        writer.pushText(token.content);
        writer.flush();
        writer.leavePreformatted();
        break;
      case "th_close":
      case "td_close":
        writer.pushText(" ");
        break;
      case "html_block":
        spliceHtml(token.content);
        break;
      case "inline":
        walkInline(token.children ?? []);
        break;
      default:
        break;
    }
  }

  return writer.finish();
}

/** The literal text an inline subtree carries — the alt of an image, which never reaches the body. */
function collectText(children: readonly Token[]): string {
  let out = "";
  for (const token of children) {
    if (token.type === "text" || token.type === "code_inline") out += token.content;
    else if (token.children) out += collectText(token.children);
  }
  return out;
}
