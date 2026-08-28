/**
 * The REST contract over the fake library and the fake issuer: validation
 * errors, the 404 envelope, content negotiation, and the two identity routes
 * (`/api/viewer` 200-null for nobody, `/api/me` 401 for nobody).
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { FAKE, ORIGIN, createFakeApp } from "./helpers.ts";

describe("api", () => {
  let t: Awaited<ReturnType<typeof createFakeApp>>;
  beforeAll(async () => {
    t = await createFakeApp();
  });
  afterAll(() => t.close());

  it("lists articles with ISO dates and the tldr in the row", async () => {
    const res = await t.fetch("/api/articles?limit=0");
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Record<string, unknown>[]; nextCursor: null };
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: FAKE.id,
      publishedAt: "2026-03-01T17:30:00.000Z",
      tldr: "一句话总结",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("400s on a query the schema rejects, with the repo's error envelope", async () => {
    const res = await t.fetch("/api/articles?limit=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    const badId = await t.fetch("/api/articles/not-a-ulid");
    expect(badId.status).toBe(400);
    const blank = await t.fetch("/api/search?q=%20%20");
    expect(blank.status).toBe(400);
  });

  it("400s on a QueryError the boundary could not see", async () => {
    const res = await t.fetch("/api/search?q=pid&cursor=bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cursor" });
  });

  it("returns the article, 404 for an unknown id", async () => {
    const ok = await t.fetch(`/api/articles/${FAKE.id}`);
    expect(ok.status).toBe(200);
    const article = (await ok.json()) as Record<string, unknown>;
    expect(article).toMatchObject({ id: FAKE.id, contentHtml: "<p>大学步兵开源底盘</p>" });
    expect((article.links as { articleId: string }[])[0]?.articleId).toBe(FAKE.otherId);
    const miss = await t.fetch(`/api/articles/${FAKE.unknownId}`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "not_found", error_description: "no such row" });
    expect((await t.fetch(`/api/articles/${FAKE.unknownId}/ai`)).status).toBe(404);
  });

  it("serves raw content with the negotiated type and X-Content-Format", async () => {
    const md = await t.fetch(`/api/articles/${FAKE.id}/content?format=markdown`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("x-content-format")).toBe("markdown");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await md.text()).toBe("# 大学步兵开源底盘");
    const text = await t.fetch(`/api/articles/${FAKE.id}/content`);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const html = await t.fetch(`/api/articles/${FAKE.id}/content?format=html`);
    expect(html.headers.get("x-content-format")).toBe("html");
    expect((await t.fetch(`/api/articles/${FAKE.id}/content?format=pdf`)).status).toBe(400);
  });

  it("search returns hits with segment snippets and the searched terms", async () => {
    const res = await t.fetch("/api/search?q=PID%20%E6%95%B4%E5%AE%9A");
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { snippet: { text: string; hit: boolean }[]; score: number }[];
      terms: string[];
    };
    expect(page.terms).toEqual(["PID", "整定"]);
    expect(page.items[0]?.score).toBe(2.5);
    expect(page.items[0]?.snippet.filter((s) => s.hit).map((s) => s.text)).toEqual(["PID", "整定"]);
  });

  it("kb browse, entities, entity detail (404 unknown), tags, status", async () => {
    expect(await (await t.fetch("/api/kb/browse?domain=%E6%8E%A7%E5%88%B6")).json()).toMatchObject({
      total: 1,
      domains: [{ name: "控制", count: 1 }],
    });
    expect(await (await t.fetch("/api/kb/entities")).json()).toEqual({
      items: [{ key: FAKE.entityKey, name: FAKE.entityName, articleCount: 1 }],
    });
    const byName = await t.fetch(`/api/kb/entities/${encodeURIComponent("HPM 5361")}`);
    expect(byName.status).toBe(200); // display name or key: entityKey() normalises either
    expect((await t.fetch("/api/kb/entities/nobody")).status).toBe(404);
    expect(await (await t.fetch("/api/tags")).json()).toMatchObject({ total: 2 });
    expect(await (await t.fetch("/api/status")).json()).toMatchObject({
      importedAt: "2026-03-08T00:00:00.000Z",
    });
  });

  it("/api/viewer is 200 null for nobody and the viewer when signed in", async () => {
    const anon = await t.fetch("/api/viewer");
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ viewer: null });
    const { cookie } = await t.signIn("u1");
    const me = await t.fetch("/api/viewer", { cookie });
    expect(me.status).toBe(200);
    // The fake issuer has no user-info API (404 there), so the viewer degrades to id + role.
    expect(await me.json()).toEqual({
      viewer: { id: "u1", role: "member", displayName: "u1", avatarUrl: null },
    });
  });

  it("/api/me is 401 with the challenge for nobody and the viewer when signed in", async () => {
    const anon = await t.fetch("/api/me");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(await anon.json()).toMatchObject({ error: expect.any(String) });
    const { cookie } = await t.signIn("u2", "admin");
    const me = await t.fetch("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: "u2",
      role: "admin",
      displayName: "u2",
      avatarUrl: null,
    });
    // A bearer for the API audience is the same principal.
    const bearer = await t.token(`${ORIGIN}/api/bbs`, "u3");
    const viaBearer = await t.fetch("/api/me", { headers: { authorization: `Bearer ${bearer}` } });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.json()).toMatchObject({ id: "u3" });
  });

  it("/healthz reflects the database ping", async () => {
    expect(await (await t.fetch("/healthz")).json()).toEqual({ ok: true });
    const down = await createFakeApp({
      ping: async () => {
        throw new Error("db down");
      },
    });
    try {
      const res = await down.fetch("/healthz");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      await down.close();
    }
  });
});
