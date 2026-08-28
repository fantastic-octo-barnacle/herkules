/**
 * The MCP surface over the fake library: ten read-only tools, the rm://
 * resources, and the audience/anonymous 401s the middleware renders before a
 * server is ever built.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  FAKE,
  MCP_RESOURCE,
  ORIGIN,
  connect,
  createFakeApp,
  fetchVia,
  legacyCall,
} from "./helpers.ts";

const PRM = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/bbs`;

describe("mcp", () => {
  let t: Awaited<ReturnType<typeof createFakeApp>>;
  let fetch: typeof globalThis.fetch;
  beforeAll(async () => {
    t = await createFakeApp();
    fetch = fetchVia(t.app);
  });
  afterAll(() => t.close());

  it("healthz is open; no token is 401 with the PRM pointer", async () => {
    expect(await (await fetch(`${MCP_RESOURCE}/healthz`)).json()).toEqual({ ok: true });
    const res = await legacyCall(MCP_RESOURCE, undefined, fetch, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM}"`);
  });

  it("a token for another audience (mcp/directory, api/bbs) is refused: done-predicate 4", async () => {
    for (const audience of [`${ORIGIN}/mcp/directory`, `${ORIGIN}/api/bbs`]) {
      const res = await legacyCall(MCP_RESOURCE, await t.token(audience), fetch, "tools/list");
      expect(res.status, audience).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });

  it("lists exactly the ten read-only tools", async () => {
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name).sort()).toEqual([
        "get_article",
        "get_entity",
        "get_kb",
        "get_overview",
        "library_status",
        "list_articles",
        "list_entities",
        "list_tags",
        "search_articles",
        "search_kb",
      ]);
      expect(tools.every((x) => x.annotations?.readOnlyHint === true)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("search_articles returns flat hits with bracketed snippets and Shanghai dates", async () => {
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const res = await client.callTool({
        name: "search_articles",
        arguments: { query: "PID 整定" },
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({
        terms: ["PID", "整定"],
        hits: [
          {
            id: FAKE.otherId,
            date: "2026-03-05",
            snippet: "…经验上 [PID] [整定] 先调 P…",
            score: 2.5,
          },
        ],
      });
      expect("nextCursor" in (res.structuredContent as object)).toBe(false);
      const bad = await client.callTool({
        name: "search_articles",
        arguments: { query: "x", cursor: "bad" },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain("invalid_cursor");
    } finally {
      await client.close();
    }
  });

  it("get_article pages content by characters and includes only what was asked", async () => {
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const res = await client.callTool({
        name: "get_article",
        arguments: { id: FAKE.id, include: ["content", "kb"], max_chars: 5 },
      });
      const out = res.structuredContent as Record<string, unknown>;
      expect(out).toMatchObject({
        id: FAKE.id,
        aiStatus: "ready",
        content: { format: "text", text: "大学步兵开", offset: 0, nextOffset: 5 },
      });
      expect(out.kb).toMatchObject({ problem: "底盘打滑" });
      expect("overview" in out).toBe(false);
      expect("links" in out).toBe(false);
      const miss = await client.callTool({
        name: "get_article",
        arguments: { id: FAKE.unknownId },
      });
      expect(miss.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("the remaining tools answer over the same library; library_status names the caller", async () => {
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, name).toBeFalsy();
        return r.structuredContent as Record<string, unknown>;
      };
      expect(await call("list_articles")).toMatchObject({
        articles: [{ id: FAKE.id }, { id: FAKE.otherId }],
      });
      expect(await call("get_overview", { id: FAKE.id })).toMatchObject({
        status: "ready",
        overview: { tldr: "一句话总结" },
        generatedAt: "2026-03-06",
      });
      expect(await call("get_overview", { id: FAKE.otherId })).toMatchObject({
        status: "pending",
        overview: null,
      });
      expect(await call("get_kb", { id: FAKE.id })).toMatchObject({
        kb: { entities: ["HPM5361"] },
      });
      expect(await call("search_kb", { domain: "控制" })).toMatchObject({
        total: 1,
        cards: [{ id: FAKE.id, genre: "教程" }],
      });
      expect(await call("list_entities")).toEqual({
        entities: [{ key: FAKE.entityKey, name: FAKE.entityName, articleCount: 1 }],
      });
      const compact = await call("get_entity", { name: "HPM 5361" });
      expect(compact).toMatchObject({
        entity: { name: FAKE.entityName },
        articles: [{ id: FAKE.id }],
      });
      expect("kb" in (compact.articles as object[])[0]!).toBe(false);
      const full = await call("get_entity", { name: FAKE.entityName, compact: false });
      expect((full.articles as { kb: unknown }[])[0]?.kb).toMatchObject({ problem: "底盘打滑" });
      expect(await call("list_tags")).toMatchObject({ total: 2 });
      expect(await call("library_status")).toMatchObject({
        articles: { fetched: 2 },
        importedAt: "2026-03-08T00:00:00.000Z",
        caller: { id: "u1", role: "member" },
      });
    } finally {
      await client.close();
    }
  });

  it("rm:// resources read through the library and 404 unknown ids", async () => {
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual([
        "rm://articles/{id}",
        "rm://articles/{id}/kb",
        "rm://articles/{id}/overview",
      ]);
      expect((await client.listResources()).resources).toEqual([]); // templates list nothing
      const md = await client.readResource({ uri: `rm://articles/${FAKE.id}` });
      expect(md.contents[0]).toMatchObject({
        mimeType: "text/markdown",
        text: "# 大学步兵开源底盘",
      });
      const ov = await client.readResource({ uri: `rm://articles/${FAKE.id}/overview` });
      expect(JSON.parse((ov.contents[0] as { text: string }).text)).toMatchObject({
        overview: { tldr: "一句话总结" },
      });
      await expect(
        client.readResource({ uri: `rm://articles/${FAKE.unknownId}` }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
