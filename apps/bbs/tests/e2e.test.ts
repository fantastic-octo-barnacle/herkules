/**
 * The done-predicate walk over the REAL stack: `createService` on PGlite with
 * the fixture corpus imported, anonymous reads, a browser session through the
 * issuer, an agent through MCP, and the wrong-audience refusal. The second
 * describe swaps the fake issuer for the real auth service (PGlite, fake
 * GitHub): the no-consent first-party login is the FRAME kill criterion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { TestBbs } from "./helpers.ts";
import { MCP_RESOURCE, ORIGIN, connect, createTestBbs, fetchVia, legacyCall } from "./helpers.ts";

interface Summary {
  id: string;
  title: string;
  titleParts: { topic: string };
  tags: string[];
}

describe("bbs end to end (fake issuer, fixture corpus)", () => {
  let t: TestBbs;
  let first: Summary;
  beforeAll(async () => {
    t = await createTestBbs();
    const page = (await (await t.fetch("/api/articles")).json()) as { items: Summary[] };
    expect(page.items.length).toBeGreaterThan(0);
    first = page.items[0]!;
  }, 60_000);
  afterAll(() => t?.close());

  it("anonymous reads: feed, article, content, ai, tags, status", async () => {
    const article = await t.fetch(`/api/articles/${first.id}`);
    expect(article.status).toBe(200);
    expect(await article.json()).toMatchObject({ id: first.id, title: first.title });
    const html = await t.fetch(`/api/articles/${first.id}/content?format=html`);
    expect(html.status).toBe(200);
    expect(html.headers.get("x-content-format")).toBe("html");
    const ai = await t.fetch(`/api/articles/${first.id}/ai`);
    expect(ai.status).toBe(200);
    expect(["pending", "ready", "failed"]).toContain(
      ((await ai.json()) as { status: string }).status,
    );
    const tags = (await (await t.fetch("/api/tags")).json()) as { total: number; items: unknown[] };
    expect(tags.total).toBeGreaterThan(0);
    const status = (await (await t.fetch("/api/status")).json()) as {
      articles: { fetched: number };
      importedAt: string | null;
    };
    expect(status.articles.fetched).toBe(tags.total);
    expect(status.importedAt).not.toBeNull();
  });

  it("search finds the first article by a term from its own title and marks the hit", async () => {
    const term = first.titleParts.topic.replace(/\s+/g, "").slice(0, 2);
    const res = await t.fetch(`/api/search?q=${encodeURIComponent(term)}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      terms: string[];
      items: { id: string; snippet: { text: string; hit: boolean }[] | null }[];
    };
    expect(page.terms).toEqual([term]);
    expect(page.items.map((h) => h.id)).toContain(first.id);
    const withSnippet = page.items.find((h) => h.snippet);
    expect(withSnippet?.snippet?.some((s) => s.hit)).toBe(true);
    // The feed's `q` uses the same recall definition.
    const feed = (await (await t.fetch(`/api/articles?q=${encodeURIComponent(term)}`)).json()) as {
      items: Summary[];
    };
    expect(feed.items.map((a) => a.id)).toContain(first.id);
  });

  it("kb browse and entities answer over the imported AI rows", async () => {
    const kb = (await (await t.fetch("/api/kb/browse")).json()) as {
      total: number;
      cards: { articleId: string }[];
      domains: { name: string; count: number }[];
    };
    expect(kb.total).toBe(kb.cards.length);
    const entities = (await (await t.fetch("/api/kb/entities")).json()) as {
      items: { key: string; name: string; articleCount: number }[];
    };
    expect(entities.items.length).toBeGreaterThan(0);
    const detail = await t.fetch(`/api/kb/entities/${encodeURIComponent(entities.items[0]!.name)}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ entity: { key: entities.items[0]!.key } });
  });

  it("the SPA shell is served with the article head injected, 404 for unknown ids", async () => {
    const known = await t.fetch(`/articles/${first.id}`);
    expect(known.status).toBe(200);
    expect(await known.text()).toContain(`/articles/${first.id}">`);
    const unknown = await t.fetch("/articles/01J0000000000000000000000Z");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("text/html");
  });

  it("a browser signs in through the issuer; /api/me knows them, anonymous is 401", async () => {
    expect((await t.fetch("/api/me")).status).toBe(401);
    const { cookie, subject } = await t.signIn("reader_1");
    const me = await t.fetch("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: subject, role: "member" });
    expect(await (await t.fetch("/api/viewer", { cookie })).json()).toMatchObject({
      viewer: { id: subject },
    });
    const out = await t.fetch("/logout", { method: "POST", cookie });
    expect(out.status).toBe(303);
  });

  it("an agent searches through MCP with a member token; another audience is refused", async () => {
    const fetch = fetchVia(t.app);
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const res = await client.callTool({
        name: "search_articles",
        arguments: { query: first.titleParts.topic.slice(0, 2) },
      });
      expect(res.isError).toBeFalsy();
      const hits = (res.structuredContent as { hits: { id: string }[] }).hits;
      expect(hits.map((h) => h.id)).toContain(first.id);
      const status = await client.callTool({ name: "library_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ caller: { id: "user_test" } });
    } finally {
      await client.close();
    }
    const refused = await legacyCall(
      MCP_RESOURCE,
      await t.token(`${ORIGIN}/mcp/directory`),
      fetch,
      "tools/list",
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("bbs against the real auth service", () => {
  let t: TestBbs;
  beforeAll(async () => {
    t = await createTestBbs({ realIssuer: true, importFixture: false });
  }, 60_000);
  afterAll(() => t?.close());

  it("first-party login lands a session without a consent screen (the kill criterion)", async () => {
    const { cookie, subject } = await t.signIn("alice");
    const me = await t.fetch("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: subject, role: "member", displayName: "alice" });
  });

  it("an issuer-minted mcp/bbs token drives the MCP server; mcp/directory is refused", async () => {
    const fetch = fetchVia(t.app);
    const client = await connect(MCP_RESOURCE, await t.token(), fetch);
    try {
      const status = await client.callTool({ name: "library_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toMatchObject({ articles: { total: 0 } });
    } finally {
      await client.close();
    }
    const refused = await legacyCall(
      MCP_RESOURCE,
      await t.token(`${ORIGIN}/mcp/directory`),
      fetch,
      "tools/list",
    );
    expect(refused.status).toBe(401);
  });
});
