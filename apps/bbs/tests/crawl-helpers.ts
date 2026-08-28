/**
 * Harness for the crawler suites (guard, source, corpus, crawl):
 *
 *   freshDb()        a migrated pglite://memory handle — no service, no import
 *   digestTables()   order-independent per-table digest for "no row changed" assertions
 *   fakeForum()      the forum as a `fetch`: POST /posts/list → a listing, /posts/info/:id → a post,
 *                    every request recorded; `fail` injects 429/403/500/non-JSON/large answers
 *   listed()/detailOf()   domain values for corpus tests without HTTP
 *   post()           a forum post DTO whose body clears MIN_BODY_CHARS
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { Extracted } from "../src/content/extract.ts";
import { extract } from "../src/content/extract.ts";
import { normalizeUrl } from "../src/content/urls.ts";
import type { BbsDb } from "../src/db/index.ts";
import { createDb, migrate, rowsOf } from "../src/db/index.ts";
import { IMPORTED_TABLES } from "../src/db/schema.ts";
import type { ArticleDetail, ListedArticle } from "../src/source/index.ts";
import { PARSER_VERSION } from "../src/source/robomaster.ts";

export const T0 = Date.UTC(2026, 7, 28, 12); // 2026-08-28T12:00Z
export const FORUM = "https://bbs.robomaster.com";

export async function freshDb(): Promise<BbsDb> {
  const db = await createDb("pglite://memory");
  await migrate(db);
  return db;
}

/** SHA-256 over the sorted JSON rows of every imported table. Equal digests ⇒ no row changed. */
export async function digestTables(
  db: BbsDb,
  tables: readonly string[] = IMPORTED_TABLES,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const rows = rowsOf(await db.execute(sql.raw(`SELECT * FROM "${table}"`)));
    const lines = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
    out[table] = createHash("sha256").update(lines.join("\n")).digest("hex");
  }
  return out;
}

export function articleUrl(id: string): string {
  return normalizeUrl(`${FORUM}/article/${id}?source=1`)!;
}

export function listed(id: string, over: Partial<ListedArticle> = {}): ListedArticle {
  return {
    sourceArticleId: id,
    url: articleUrl(id),
    title: `文章 ${id}`,
    author: "作者",
    publishedAt: new Date(T0 - 86_400_000),
    isPinned: false,
    introduction: null,
    tags: [],
    listingPosition: 0,
    ...over,
  };
}

export const LONG_BODY = "这是一段足够长的正文，用来让测试文章超过最小字符数的门槛。".repeat(5); // 145 code points

export function detailOf(
  l: ListedArticle,
  over: Partial<ArticleDetail> & { readonly bodyText?: string } = {},
): ArticleDetail {
  const raw = over.raw ?? `<p>${over.bodyText ?? LONG_BODY}</p>`;
  const format = over.format ?? "html";
  const extracted: Extracted = over.extracted ?? extract(format, raw, l.url);
  const { bodyText: _b, ...rest } = over;
  return { ...l, format, raw, extracted, parserVersion: PARSER_VERSION, ...rest };
}

// ── fake forum ──────────────────────────────────────────────────────────────

export interface ForumPost {
  id: number | string;
  title?: string;
  introduction?: string | null;
  authorNickname?: string | null;
  createAt?: number | string | null;
  top?: boolean;
  tags?: { groupName?: string | null; name?: string | null }[];
  contentType?: string;
  htmlContent?: string | null;
  markdownContent?: string | null;
  attachments?: { src?: string; name?: string }[] | null;
  fileItems?: { src?: string; name?: string }[] | null;
  references?: { url?: string; title?: string }[] | null;
}

/** A post with a body that clears MIN_BODY_CHARS. */
export function post(id: number | string, over: Partial<ForumPost> = {}): ForumPost {
  return {
    id,
    title: `文章 ${id}`,
    authorNickname: "作者",
    createAt: "2026-08-20 14:03:22",
    top: false,
    tags: [{ groupName: "视觉", name: "自瞄" }],
    contentType: "HTML",
    htmlContent: `<h2>正文</h2><p>${LONG_BODY}</p><p><a href="https://github.com/example/${id}">源码</a></p>`,
    ...over,
  };
}

export interface ForumRequest {
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly init: RequestInit;
}

export type Injected =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { throw: Error }
  | { json: unknown };

export interface FakeForum {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: ForumRequest[];
  /** Posts served at /posts/info/:id; a missing id answers post_missing (data: null). */
  readonly posts: Map<string, ForumPost>;
  /** Pages served at /posts/list; a missing page answers an empty list. */
  readonly pages: Map<number, ForumPost[]>;
  total: number;
  /** The next N requests answer with this instead (FIFO). */
  inject(...answers: Injected[]): void;
}

export function fakeForum(init?: {
  pages?: ForumPost[][];
  posts?: ForumPost[];
  total?: number;
}): FakeForum {
  const queue: Injected[] = [];
  const pages = new Map<number, ForumPost[]>();
  (init?.pages ?? []).forEach((p, i) => pages.set(i + 1, p));
  const posts = new Map<string, ForumPost>();
  for (const p of [...(init?.pages ?? []).flat(), ...(init?.posts ?? [])]) {
    posts.set(String(p.id), p);
  }
  const forum: FakeForum = {
    requests: [],
    posts,
    pages,
    total: init?.total ?? [...pages.values()].reduce((n, p) => n + p.length, 0),
    inject: (...answers) => queue.push(...answers),
    fetch: async (input, reqInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers: Record<string, string> = {};
      new Headers(reqInit?.headers).forEach((v, k) => (headers[k] = v));
      const body = reqInit?.body ? JSON.parse(String(reqInit.body)) : null;
      forum.requests.push({ path: url.pathname, body, headers, init: reqInit ?? {} });
      const injected = queue.shift();
      if (injected) {
        if ("throw" in injected) throw injected.throw;
        if ("json" in injected) return json(injected.json);
        return new Response(injected.body ?? "", {
          status: injected.status,
          headers: injected.headers ?? {},
        });
      }
      if (url.pathname === "/developers-server/rest/posts/list") {
        const page = Number((body as { pageNo: number }).pageNo);
        return json({
          success: true,
          code: 0,
          data: { total: forum.total, list: pages.get(page) ?? [] },
        });
      }
      const m = /^\/developers-server\/rest\/posts\/info\/(.+)$/.exec(url.pathname);
      if (m) {
        const found = posts.get(m[1]!);
        return found
          ? json({ success: true, data: found })
          : json({ success: false, code: 404, message: "post not found", data: null });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return forum;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}
