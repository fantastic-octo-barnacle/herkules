/**
 * wenku-core url.rs + links.rs + lib.rs::reference_target. All pure. The URL
 * normalisation decides `canonical_url` and link dedupe, so it is also what
 * import/derive.ts resolveLinkTarget's `byCanonicalUrl` lookups depend on —
 * two sides of one rule.
 *
 * Parity note: WHATWG `URL` and the Rust `url` crate agree on everything the
 * corpus contains (checked against the fixture corpus in Phase D); the kept
 * query is re-serialised with URLSearchParams exactly as `query_pairs_mut`
 * did (`+` for spaces), so a `canonical_url` minted here equals rm-wenku's.
 */
export type LinkKind = "repository" | "document" | "download" | "video" | "cloud_drive" | "other";

const TRACKING_PARAMS = new Set(["spm", "from", "ref"]);
const REPOSITORY_HOSTS = ["github.com", "gitee.com", "gitlab.com"];
const VIDEO_HOSTS = ["bilibili.com", "youtube.com", "youtu.be", "vimeo.com"];
const CLOUD_DRIVE_HOSTS = ["pan.baidu.com", "aliyundrive.com", "cloud.189.cn"];
const DOCUMENT_HOST_PREFIXES = ["docs.", "doc.", "notion.", "yuque.", "feishu.", "larksuite."];
const DOWNLOAD_EXTENSIONS = new Set([
  "zip",
  "rar",
  "7z",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "tar",
  "gz",
]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function isTrackingParam(key: string): boolean {
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/** Drop fragment; drop utm_* / spm / from / ref params (query dropped when empty); lower-case host; keep param order. Null when unparsable. */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  url.hash = "";
  const kept = [...url.searchParams].filter(([key]) => !isTrackingParam(key));
  if (kept.length === 0) {
    url.search = "";
  } else {
    url.search = new URLSearchParams(kept).toString();
  }
  // WHATWG lower-cases special-scheme hosts already; `hostname` is authoritative.
  return url.href;
}

/** Resolve `href` against `base` and normalise the result. */
export function resolveAndNormalize(base: string, href: string): string | null {
  try {
    return normalizeUrl(new URL(href, base).href);
  } catch {
    return null;
  }
}

function hostMatches(host: string, candidates: readonly string[]): boolean {
  return candidates.some((c) => host === c || host.endsWith(`.${c}`));
}

function hasExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot >= 0 && extensions.has(file.slice(dot + 1));
}

/** Host match (repo/video/cloud), then 12 download extensions, then 6 document host substrings; download beats document. */
export function classifyLink(url: URL): LinkKind {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, REPOSITORY_HOSTS)) return "repository";
  if (hostMatches(host, VIDEO_HOSTS)) return "video";
  if (hostMatches(host, CLOUD_DRIVE_HOSTS)) return "cloud_drive";
  if (hasExtension(path, DOWNLOAD_EXTENSIONS)) return "download";
  if (DOCUMENT_HOST_PREFIXES.some((p) => host.includes(p))) return "document";
  return "other";
}

/** jpg jpeg png gif webp on the last path segment of `name ?? url` (query/fragment stripped). SVG is deliberately absent. */
export function isImageResource(url: string, name: string | null): boolean {
  const candidate = name && name.trim() !== "" ? name : url;
  const withoutQuery = candidate.split(/[?#]/)[0] ?? "";
  return hasExtension(withoutQuery.toLowerCase(), IMAGE_EXTENSIONS);
}

/** `bbs://reference.com/{…}/{postId}/{order}` → `https://bbs.robomaster.com/article/{postId}`; null unless postId is all digits. */
export function referenceTarget(dataLink: string): string | null {
  const prefix = "bbs://reference.com/";
  if (!dataLink.startsWith(prefix)) return null;
  const parts = dataLink.slice(prefix.length).replace(/\/+$/, "").split("/");
  if (parts.length < 2) return null;
  const postId = parts[parts.length - 2] ?? "";
  return /^[0-9]+$/.test(postId) ? `https://bbs.robomaster.com/article/${postId}` : null;
}
