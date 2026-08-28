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
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Library } from "../library/index.ts";

export const SERVER_INFO = { name: "rm-wenku", version: "2.0.0" } as const;

export interface BbsMcpDeps {
  readonly library: Library;
  /** For `rm://` resource URIs and the article links tools return. */
  readonly appOrigin: string;
}

const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);
const scope = z.enum(["all", "title", "kb"]).default("all");
const tagFilters = { tag: z.string().optional(), group: z.string().optional() };

export function createBbsServer(principal: Principal, deps: BbsMcpDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "RM 文库: the RoboMaster developer-forum archive — ~900 Chinese articles with tags, links and images, plus model-written overviews and knowledge-base entries for ~105 of them. Search is substring-based; prefer specific Chinese terms or part numbers. Every tool is read-only.",
  });
  void principal;
  void deps;
  void limit;
  void scope;
  void tagFilters;
  void ResourceTemplate;
  void structured;
  void failure;
  // TODO server.registerTool("search_articles", { title, description, inputSchema: { query: z.string().min(1), scope, ...tagFilters,
  //        limit: limit(50, 10), cursor: z.string().optional() }, outputSchema: { hits: z.array(hitOutput), nextCursor: z.string().optional() },
  //        annotations: { readOnlyHint: true } },
  //      async (i) => { const p = await deps.library.search({ q: i.query, scope: i.scope, tag: i.tag, group: i.group, limit: i.limit, cursor: i.cursor as Cursor })
  //                     return structured({ hits: p.items.map(articleHit), nextCursor: p.nextCursor ?? undefined }, `${p.items.length} 篇`) })
  // TODO the other nine per the table; `library_status` adds { caller: { id: principal.subject, role: principal.role } }
  // TODO resources: server.registerResource("article", new ResourceTemplate("rm://articles/{id}", { list: undefined }), …)
  //      rm://articles/{id} -> content(id, "markdown"); rm://articles/{id}/overview | /kb -> JSON of the ArticleAi slices.
  //      Templates list nothing (969 URIs is not a menu); `read` resolves the id.
  return server;
}

function structured(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
