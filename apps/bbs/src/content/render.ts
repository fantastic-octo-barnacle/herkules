/**
 * `content_raw` -> sanitised `content_html`. A port of rm-wenku's
 * `wenku-core/src/render.rs` + `style.rs` (pulldown-cmark + ammonia) to
 * markdown-it + sanitize-html, run ONCE per article at import time.
 *
 * THIS IS A SECURITY BOUNDARY. Its output is injected into the reader with
 * `dangerouslySetInnerHTML` and nothing downstream sanitises again. A permissive
 * port here is an XSS in the archive, so: the allowlist is written out
 * explicitly, not inherited from a library default; and it gets its own test
 * file with the adversarial cases (`<script>`, `javascript:` hrefs, `onerror`,
 * `<iframe>` to a non-allowlisted host, `style` outside the allowlist, `data:` images).
 *
 * Pipeline, in the Rust order:
 *  1. markdown sources -> HTML via markdown-it (tables, strikethrough, task lists; `html: false`).
 *  2. resolve every relative `src`/`href` against the article's canonical URL — the corpus
 *     hot-links the forum CDN and stores nothing locally.
 *  3. rewrite WangEditor `[n]` reference markers into anchors labelled by the referenced link.
 *  4. sanitise against ALLOWED. Forced attributes, verbatim from ammonia's configuration:
 *       a      target="_blank" rel="noopener noreferrer nofollow"
 *       img    loading="lazy" referrerpolicy="no-referrer"
 *       video  controls preload="metadata" playsinline
 *       iframe only when `isEmbedUrl(src)`;  input only type="checkbox" disabled;  code class ~ /^language-/
 *     MathML passes; inline `style` is filtered to a property allowlist.
 *  5. strip a leading `<h1>` that duplicates the title.
 *
 * RENDER_VERSION is bumped on ANY change to this file or its allowlists; the
 * import records it and treats a differing version as "must reload" even when
 * source digests match.
 */

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

/** Pure: (format, raw, base URL, title, links) -> sanitised HTML. */
export function renderArticleHtml(input: RenderInput): string {
  void input;
  throw new Error("not implemented");
}

/** `<span data-w-e-type="reference" data-link="…/{postId}/{n}">[n]</span>` -> `<a href="https://bbs.robomaster.com/article/{postId}">[n] label</a>`. */
export function rewriteReferences(html: string, links: readonly RenderLink[]): string {
  void html;
  void links;
  throw new Error("not implemented");
}

/** Allowlisted video hosts (bilibili, youtube) only; everything else is dropped by sanitize. */
export function isEmbedUrl(url: string): boolean {
  void url;
  throw new Error("not implemented");
}

export function sanitize(html: string, baseUrl: string): string {
  void html;
  void baseUrl;
  // TODO sanitize-html with ALLOWED + allowedStyles from style.rs; transformTags for a/img/video/iframe; resolve URLs against baseUrl
  throw new Error("not implemented");
}

/** Drop a leading `<h1>` whose text equals `title` after whitespace normalisation. */
export function stripTitleHeading(html: string, title: string): string {
  void html;
  void title;
  throw new Error("not implemented");
}

/** The allowlist, exported so the test can assert on it rather than on rendered output alone. */
export const ALLOWED = {
  tags: [] as readonly string[],
  attributes: {} as Readonly<Record<string, readonly string[]>>,
  styleProperties: [] as readonly string[],
  embedHosts: [] as readonly string[],
} as const;
