/**
 * The MCP server at /mcp/bbs: rm-wenku's ten read tools over the SAME Library
 * the REST API uses, plus the `rm://articles/{id}` resources. Built FRESH per
 * request around the verified caller (services/mcp-directory template); a
 * server instance never outlives the principal it was built for.
 *
 * `ask_article` is omitted: inference is out of scope. AUTH: every MCP call
 * requires a member — enforced by `honoAuth(deps.mcp)` in app.ts before this
 * file runs; a token minted for `mcp/directory` is refused there with the
 * contract's 401 (done-predicate 4). The web is a public archive, agents are
 * members: the frame's decision, not an oversight.
 *
 * | tool            | input                                                    | library call            |
 * | --------------- | -------------------------------------------------------- | ----------------------- |
 * | search_articles | query, scope?, tag?, group?, limit 1..50 (10), cursor?   | search()                |
 * | list_articles   | tag?, group?, limit 1..50 (20), cursor?                  | articles() (tldr in row)|
 * | get_article     | id, include[] (content|overview|kb|links|images) default | article() + content() + |
 * |                 | [content,overview,links], format text|markdown,          |   ai(), only if included|
 * |                 | max_chars, offset                                        |                         |
 * | get_overview    | id                                                       | ai().overview           |
 * | get_kb          | id                                                       | ai().kb + images        |
 * | search_kb       | query?, domain?, robot?, genre?, limit 1..50 (20)        | kbBrowse({ q })         |
 * | list_entities   | limit 1..500 (100), query?                               | entities()              |
 * | get_entity      | name, compact (default true)                             | entity()                |
 * | list_tags       | —                                                        | tags()                  |
 * | library_status  | —                                                        | status() + caller       |
 * Two rm-wenku tool bugs gone for free: `list_articles` no longer fetches a tldr per row;
 * `search_kb` no longer intersects a 1000-row browse with a 100-row search client-side
 * (`q` is pushed into the browse SQL). All tools: `annotations: { readOnlyHint: true }`.
 */
import type { Principal } from "@herkules/auth-middleware";
import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ArticleId, Cursor, Library } from "../library/index.ts";
import { QueryError, articleId, entityKey } from "../library/index.ts";
import {
  DEFAULT_MAX_CHARS,
  MAX_MAX_CHARS,
  articleHit,
  kbCardOut,
  shanghaiDate,
  sliceContent,
} from "./present.ts";

export const SERVER_INFO = { name: "rm-wenku", version: "2.0.0" } as const;

export interface BbsMcpDeps {
  readonly library: Library;
  /** For `rm://` resource URIs and the article links tools return. */
  readonly appOrigin: string;
}

const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);
const scope = z.enum(["all", "title", "kb"]).default("all");
const tagFilters = {
  tag: z.string().optional().describe("Exact `group/name` tag"),
  group: z.string().optional().describe("Tag group (the part before `/`)"),
};
const idInput = z.string().describe("Article id (26-character ULID)");
const cursorInput = z.string().optional().describe("Opaque cursor from a previous page");

const hitOutput = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().optional(),
  date: z.string(),
  url: z.string(),
  tags: z.array(z.string()),
  excerpt: z.string().optional(),
  snippet: z.string().optional(),
  tldr: z.string().optional(),
  score: z.number(),
  bodyChars: z.number(),
});
const countOutput = z.array(z.object({ name: z.string(), count: z.number() }));
const anyRecord = z.record(z.string(), z.unknown());

export function createBbsServer(principal: Principal, deps: BbsMcpDeps): McpServer {
  const lib = deps.library;
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "RM 文库: the RoboMaster developer-forum archive — ~900 Chinese articles with tags, links and images, plus model-written overviews and knowledge-base entries for ~105 of them. Search is substring-based; prefer specific Chinese terms or part numbers. Every tool is read-only.",
  });
  const readOnly = { readOnlyHint: true } as const;
  const idOf = (raw: string): ArticleId | null => articleId(raw);

  server.registerTool(
    "search_articles",
    {
      title: "Search articles",
      description:
        "Ranked substring search over titles, authors, tags, introductions and bodies (scope=all), titles only (scope=title) or the knowledge-base entries (scope=kb). Every whitespace-separated term must occur. Returns snippets with [term] markers.",
      inputSchema: z.object({
        query: z.string().min(1),
        scope,
        ...tagFilters,
        limit: limit(50, 10),
        cursor: cursorInput,
      }),
      outputSchema: z.object({
        hits: z.array(hitOutput),
        terms: z.array(z.string()),
        nextCursor: z.string().optional(),
      }),
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const page = await lib.search({
          q: i.query,
          scope: i.scope,
          tag: i.tag,
          group: i.group,
          limit: i.limit,
          cursor: i.cursor as Cursor | undefined,
        });
        return structured(
          {
            hits: page.items.map(articleHit),
            terms: page.terms,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
          `${page.items.length} 篇${page.nextCursor ? "（还有更多）" : ""}`,
        );
      }),
  );

  server.registerTool(
    "list_articles",
    {
      title: "List articles",
      description: "The date-ordered feed (newest first), optionally filtered by tag or group.",
      inputSchema: z.object({ ...tagFilters, limit: limit(50, 20), cursor: cursorInput }),
      outputSchema: z.object({ articles: z.array(hitOutput), nextCursor: z.string().optional() }),
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const page = await lib.articles({
          tag: i.tag,
          group: i.group,
          limit: i.limit,
          cursor: i.cursor as Cursor | undefined,
        });
        return structured(
          {
            articles: page.items.map(articleHit),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
          `${page.items.length} 篇${page.nextCursor ? "（还有更多）" : ""}`,
        );
      }),
  );

  server.registerTool(
    "get_article",
    {
      title: "Get article",
      description:
        "One article. `include` selects content (paged by characters), overview, kb, links, images; default content+overview+links.",
      inputSchema: z.object({
        id: idInput,
        include: z
          .array(z.enum(["content", "overview", "kb", "links", "images"]))
          .default(["content", "overview", "links"]),
        format: z.enum(["text", "markdown"]).default("text"),
        max_chars: z.number().int().min(1).max(MAX_MAX_CHARS).default(DEFAULT_MAX_CHARS),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: anyRecord,
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const id = idOf(i.id);
        const article = id ? await lib.article(id) : null;
        if (!id || !article) return failure(`No article ${i.id}`);
        const want = new Set(i.include);
        const out: Record<string, unknown> = {
          ...articleHit(article),
          ...(article.introduction ? { introduction: article.introduction } : {}),
        };
        if (want.has("content")) {
          const content = await lib.content(id, i.format);
          if (content) {
            out.content = {
              format: content.format,
              ...sliceContent(content.body, i.offset, i.max_chars),
            };
          }
        }
        if (want.has("overview") || want.has("kb")) {
          const ai = await lib.ai(id);
          out.aiStatus = ai?.status ?? "pending";
          if (want.has("overview")) out.overview = ai?.overview ?? null;
          if (want.has("kb")) {
            out.kb = ai?.kb ?? null;
            out.imageCaptions = ai?.images ?? [];
          }
        }
        if (want.has("links")) {
          out.links = article.links.map((l) => ({
            url: l.url,
            kind: l.kind,
            ...(l.label ? { label: l.label } : {}),
            ...(l.articleId ? { articleId: l.articleId } : {}),
          }));
        }
        if (want.has("images")) {
          out.images = article.images.map((im) => ({
            url: im.url,
            ...(im.alt ? { alt: im.alt } : {}),
          }));
        }
        const slice = out.content as { nextOffset?: number; totalChars?: number } | undefined;
        return structured(
          out,
          `${article.title}${slice?.nextOffset !== undefined ? ` (content continues at offset ${slice.nextOffset} of ${slice.totalChars})` : ""}`,
        );
      }),
  );

  server.registerTool(
    "get_overview",
    {
      title: "Get overview",
      description:
        "The model-written overview (tldr, summary, key points, FAQ) of one article; status pending when none exists.",
      inputSchema: z.object({ id: idInput }),
      outputSchema: anyRecord,
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const id = idOf(i.id);
        const ai = id ? await lib.ai(id) : null;
        if (!ai) return failure(`No article ${i.id}`);
        return structured(
          {
            id: ai.articleId,
            status: ai.status,
            overview: ai.overview,
            ...(ai.model ? { model: ai.model } : {}),
            ...(ai.generatedAt ? { generatedAt: shanghaiDate(ai.generatedAt) } : {}),
            ...(ai.error ? { error: ai.error } : {}),
          },
          ai.overview?.tldr ?? `overview ${ai.status}`,
        );
      }),
  );

  server.registerTool(
    "get_kb",
    {
      title: "Get knowledge-base entry",
      description:
        "The structured knowledge-base entry (problem, approach, components, parameters, decisions, pitfalls, entities) plus image captions of one article.",
      inputSchema: z.object({ id: idInput }),
      outputSchema: anyRecord,
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const id = idOf(i.id);
        const ai = id ? await lib.ai(id) : null;
        if (!ai) return failure(`No article ${i.id}`);
        return structured(
          { id: ai.articleId, status: ai.status, kb: ai.kb, images: ai.images },
          ai.kb?.problem ?? `kb ${ai.status}`,
        );
      }),
  );

  server.registerTool(
    "search_kb",
    {
      title: "Search knowledge base",
      description:
        "Knowledge-base cards filtered by a substring query and/or domain, robot type, genre; returns the cards and the facet counts.",
      inputSchema: z.object({
        query: z.string().optional(),
        domain: z.string().optional(),
        robot: z.string().optional(),
        genre: z.string().optional(),
        limit: limit(50, 20),
      }),
      outputSchema: z.object({
        total: z.number(),
        cards: z.array(anyRecord),
        domains: countOutput,
        robotTypes: countOutput,
        genres: countOutput,
      }),
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const kb = await lib.kbBrowse({
          q: i.query,
          domain: i.domain,
          robot: i.robot,
          genre: i.genre,
          limit: i.limit,
        });
        return structured(
          {
            total: kb.total,
            cards: kb.cards.map(kbCardOut),
            domains: kb.domains,
            robotTypes: kb.robotTypes,
            genres: kb.genres,
          },
          `${kb.cards.length} of ${kb.total} entries`,
        );
      }),
  );

  server.registerTool(
    "list_entities",
    {
      title: "List entities",
      description:
        "Named entities (parts, boards, algorithms, teams) with article counts, most-cited first; `query` filters by name substring.",
      inputSchema: z.object({ limit: limit(500, 100), query: z.string().optional() }),
      outputSchema: z.object({
        entities: z.array(
          z.object({ key: z.string(), name: z.string(), articleCount: z.number() }),
        ),
      }),
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const entities = await lib.entities({ q: i.query, limit: i.limit });
        return structured(
          {
            entities: entities.map((e) => ({
              key: e.key,
              name: e.name,
              articleCount: e.articleCount,
            })),
          },
          `${entities.length} entities`,
        );
      }),
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description:
        "One entity by name or key with every article that mentions it (newest first). compact=false includes each article's full kb entry.",
      inputSchema: z.object({ name: z.string().min(1), compact: z.boolean().default(true) }),
      outputSchema: anyRecord,
      annotations: readOnly,
    },
    (i) =>
      guarded(async () => {
        const detail = await lib.entity(entityKey(i.name));
        if (!detail) return failure(`No entity ${i.name}`);
        return structured(
          {
            entity: detail.entity,
            articles: detail.articles.map((a) => ({
              id: a.articleId,
              title: a.title,
              ...(a.author ? { author: a.author } : {}),
              ...(a.publishedAt ? { date: shanghaiDate(a.publishedAt) } : {}),
              tldr: a.tldr,
              ...(i.compact ? {} : { kb: a.kb }),
            })),
          },
          `${detail.entity.name}: ${detail.articles.length} 篇`,
        );
      }),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "Every `group/name` tag with its article count, the group counts, and the fetched total.",
      inputSchema: z.object({}),
      outputSchema: z.object({ items: countOutput, groups: countOutput, total: z.number() }),
      annotations: readOnly,
    },
    () =>
      guarded(async () => {
        const t = await lib.tags();
        return structured(
          { items: t.items, groups: t.groups, total: t.total },
          `${t.items.length} tags in ${t.groups.length} groups over ${t.total} articles`,
        );
      }),
  );

  server.registerTool(
    "library_status",
    {
      title: "Library status",
      description: "Counts of the archive, when the corpus was imported, and who is asking.",
      inputSchema: z.object({}),
      outputSchema: anyRecord,
      annotations: readOnly,
    },
    () =>
      guarded(async () => {
        const s = await lib.status();
        return structured(
          {
            site: s.site,
            articles: s.articles,
            ai: s.ai,
            crawler: {
              lastCheckedAt: s.crawler.lastCheckedAt?.toISOString() ?? null,
              backfillCompletedAt: s.crawler.backfillCompletedAt?.toISOString() ?? null,
            },
            importedAt: s.importedAt?.toISOString() ?? null,
            caller: { id: principal.subject, role: principal.role },
          },
          `${s.articles.fetched} articles, ${s.ai.ready} with AI output; imported ${s.importedAt ? shanghaiDate(s.importedAt) : "never"}`,
        );
      }),
  );

  const notFound = (uri: URL) => new ResourceNotFoundError(uri.href);
  const resolve = (variables: Record<string, string | string[]>): ArticleId | null => {
    const raw = variables.id;
    return typeof raw === "string" ? articleId(raw) : null;
  };

  server.registerResource(
    "article",
    new ResourceTemplate("rm://articles/{id}", { list: undefined }),
    { title: "Article (markdown or text)", mimeType: "text/markdown" },
    async (uri, variables) => {
      const id = resolve(variables);
      const content = id ? await lib.content(id, "markdown") : null;
      if (!content) throw notFound(uri);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: content.format === "markdown" ? "text/markdown" : "text/plain",
            text: content.body,
          },
        ],
      };
    },
  );
  server.registerResource(
    "article-overview",
    new ResourceTemplate("rm://articles/{id}/overview", { list: undefined }),
    { title: "Article overview (JSON)", mimeType: "application/json" },
    async (uri, variables) => {
      const id = resolve(variables);
      const ai = id ? await lib.ai(id) : null;
      if (!ai) throw notFound(uri);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ status: ai.status, overview: ai.overview }),
          },
        ],
      };
    },
  );
  server.registerResource(
    "article-kb",
    new ResourceTemplate("rm://articles/{id}/kb", { list: undefined }),
    { title: "Article knowledge-base entry (JSON)", mimeType: "application/json" },
    async (uri, variables) => {
      const id = resolve(variables);
      const ai = id ? await lib.ai(id) : null;
      if (!ai) throw notFound(uri);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ status: ai.status, kb: ai.kb, images: ai.images }),
          },
        ],
      };
    },
  );

  return server;
}

function structured(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A caller mistake the boundary could not see (bad cursor, blank query) is a tool error, never a protocol failure. */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QueryError) return failure(`${err.code}: ${err.message}`);
    throw err;
  }
}
