/**
 * The RoboMaster developer forum adapter: two endpoints, the DTOs, and the
 * mapping to domain types — one file, because the DTOs exist only to be mapped
 * and nothing else may see them (only createRobomasterSource and the constants
 * are exported). Port of wenku-source/robomaster/{mod,dto,map}.rs.
 *
 * PARSER_VERSION "rm-api-v5" is stored in articles.parser_version; bump it when
 * the mapping or content/extract.ts changes what body_text/links/images are.
 */
import { z } from "zod";

import { extract } from "../content/extract.ts";
import { cleanText } from "../content/text.ts";
import { isImageResource, normalizeUrl } from "../content/urls.ts";
import type { Guard } from "../guard/index.ts";
import { createJsonClient } from "./http.ts";
import type { ArticleDetail, ListedArticle, Listing, Source } from "./index.ts";
import { SOURCE_ID, SourceError } from "./index.ts";

export const PARSER_VERSION = "rm-api-v5";
export const FORUM_ORIGIN = "https://bbs.robomaster.com";
export const SITE_URL = `${FORUM_ORIGIN}/article`;
export const SOURCE_NAME = "RoboMaster Developer Community";
export const SOURCE_KIND = "robomaster";

const LIST_PATH = "/developers-server/rest/posts/list";
const INFO_PATH = "/developers-server/rest/posts/info/"; // + id
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CST_OFFSET_MS = 8 * 3_600_000; // offset-less timestamps are Beijing time

// ── wire (private) ──────────────────────────────────────────────────────────
// Lenient on purpose: ids may be number|string, createAt ms|string, tags optional,
// nullable everywhere the forum sends null. Unknown keys pass; a missing
// envelope or `success:false` is SourceError invalid.
const tagDto = z.object({
  groupName: z.string().nullish(),
  name: z.string().nullish(),
});
const listItemDto = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  title: z.string().nullish(),
  introduction: z.string().nullish(),
  authorNickname: z.string().nullish(),
  createAt: z.union([z.number(), z.string()]).nullish(),
  top: z.boolean().nullish(),
  tags: z.array(tagDto).nullish(),
});
const fileDto = z.object({ src: z.string().nullish(), name: z.string().nullish() });
const postDto = listItemDto.extend({
  contentType: z.string().nullish(),
  htmlContent: z.string().nullish(),
  markdownContent: z.string().nullish(),
  attachments: z.array(fileDto).nullish(),
  fileItems: z.array(fileDto).nullish(),
  references: z
    .array(z.object({ url: z.string().nullish(), title: z.string().nullish() }))
    .nullish(),
});
const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    success: z.boolean().nullish(),
    code: z.unknown().optional(),
    message: z.string().nullish(),
    data,
  });
const listEnvelope = envelope(
  z.object({ total: z.number().nullish(), list: z.array(listItemDto).nullish() }).nullable(),
);
const infoEnvelope = envelope(postDto.nullable());

type ListItemDto = z.infer<typeof listItemDto>;
type PostDto = z.infer<typeof postDto>;

export interface RobomasterDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly guard: Guard;
}

export function createRobomasterSource(deps: RobomasterDeps): Source {
  const client = createJsonClient({ fetch: deps.fetch, guard: deps.guard, origin: FORUM_ORIGIN });
  return {
    id: SOURCE_ID,
    siteUrl: SITE_URL,
    async listPage(page, pageSize, priority): Promise<Listing> {
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
        throw new SourceError({ kind: "invalid", message: `bad page ${page}/${pageSize}` });
      }
      const json = await client.postJson(
        LIST_PATH,
        {
          pageSize,
          pageNo: page,
          filter: { category: "ARTICLE", sortByCreateAt: true, tagIds: [] },
        },
        priority,
      );
      const parsed = listEnvelope.safeParse(json);
      if (!parsed.success || parsed.data.success === false || !parsed.data.data) {
        throw new SourceError({ kind: "invalid", message: envelopeProblem(parsed, json) });
      }
      const list = parsed.data.data.list ?? [];
      const total = parsed.data.data.total ?? list.length;
      const items = list.map((dto, i) => mapListed(dto, (page - 1) * pageSize + i));
      return {
        items,
        total,
        page,
        pageSize,
        isLast: items.length < pageSize || page * pageSize >= total,
      };
    },
    async fetchDetail(sourceArticleId, priority): Promise<ArticleDetail> {
      if (!ID_PATTERN.test(sourceArticleId)) {
        throw new SourceError({ kind: "invalid", message: `bad post id ${sourceArticleId}` });
      }
      const json = await client.postJson(INFO_PATH + sourceArticleId, {}, priority);
      const parsed = infoEnvelope.safeParse(json);
      if (!parsed.success) {
        throw new SourceError({ kind: "invalid", message: envelopeProblem(parsed, json) });
      }
      if (parsed.data.data === null) throw new SourceError({ kind: "notFound" });
      if (parsed.data.success === false) {
        throw new SourceError({
          kind: "invalid",
          message: `success=false: ${parsed.data.message ?? "no message"}`,
        });
      }
      return mapDetail(parsed.data.data);
    },
  };
}

function envelopeProblem(parsed: { success: boolean; error?: z.ZodError }, json: unknown): string {
  if (parsed.error)
    return `unexpected response shape: ${z.prettifyError(parsed.error)}`.slice(0, 400);
  const msg =
    typeof json === "object" && json !== null && "message" in json
      ? String((json as { message: unknown }).message)
      : "";
  return `forum reported failure${msg ? `: ${msg}` : ""}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = cleanText(value);
  return cleaned === "" ? null : cleaned;
}

/** The listing mapping; shared by mapDetail. Throws invalid on empty title / missing id. */
function mapListed(dto: ListItemDto, listingPosition: number): ListedArticle {
  if (dto.id === null || dto.id === undefined || String(dto.id) === "") {
    throw new SourceError({ kind: "invalid", message: "post has no id" });
  }
  const id = String(dto.id);
  const title = nonEmpty(dto.title);
  if (!title) throw new SourceError({ kind: "invalid", message: `post ${id} has no title` });
  const url = normalizeUrl(`${FORUM_ORIGIN}/article/${encodeURIComponent(id)}?source=1`);
  if (!url) throw new SourceError({ kind: "invalid", message: `post ${id}: unmintable url` });
  return {
    sourceArticleId: id,
    url,
    title,
    author: nonEmpty(dto.authorNickname),
    publishedAt: parseTime(dto.createAt),
    isPinned: dto.top ?? false,
    introduction: nonEmpty(dto.introduction),
    tags: mapTags(dto.tags ?? []),
    listingPosition,
  };
}

function mapTags(tags: readonly z.infer<typeof tagDto>[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const tag = [nonEmpty(t.groupName), nonEmpty(t.name)].filter((s) => s !== null).join("/");
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * ms epoch | RFC 3339 (with offset) | "YYYY-MM-DD HH:MM:SS" | "YYYY-MM-DDTHH:MM:SS" | "YYYY-MM-DD";
 * offset-less values are Beijing time (UTC+8); anything else → null, never a throw.
 */
export function parseTime(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(text);
  if (!naive) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = naive;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(utc)) return null;
  // Reject impossible dates that Date.UTC would have rolled over (e.g. 2026-02-30), as chrono does.
  const check = new Date(utc);
  if (check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(mo) - 1) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return new Date(utc - CST_OFFSET_MS);
}

function mapDetail(dto: PostDto): ArticleDetail {
  const listed = mapListed(dto, 0);
  const prefersMd = (dto.contentType ?? "").toUpperCase() === "MARKDOWN";
  const md = dto.markdownContent && dto.markdownContent.trim() !== "" ? dto.markdownContent : null;
  const html = dto.htmlContent && dto.htmlContent.trim() !== "" ? dto.htmlContent : null;
  let format: "html" | "markdown";
  let raw: string;
  if ((prefersMd && md) || (md && !html)) {
    format = "markdown";
    raw = md;
  } else if (html) {
    format = "html";
    raw = html;
  } else {
    throw new SourceError({
      kind: "invalid",
      message: `post ${listed.sourceArticleId} has no content`,
    });
  }

  const links: { url: string; label: string | null }[] = [];
  const images: { url: string; alt: string | null }[] = [];
  for (const file of [...(dto.attachments ?? []), ...(dto.fileItems ?? [])]) {
    const src = file.src?.trim() ?? "";
    if (src === "") continue;
    const name = nonEmpty(file.name);
    if (isImageResource(src, name)) images.push({ url: src, alt: name });
    else links.push({ url: src, label: name });
  }
  for (const ref of dto.references ?? []) {
    const url = ref.url?.trim() ?? "";
    if (url === "") continue;
    links.push({ url, label: nonEmpty(ref.title) });
  }

  return {
    ...listed,
    format,
    raw,
    extracted: extract(format, raw, listed.url, { links, images }),
    parserVersion: PARSER_VERSION,
  };
}
