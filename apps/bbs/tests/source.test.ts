/** The forum adapter and the HTTP client against a recorded fake: mapping, request shape, classification, settling. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { fakeClock } from "../src/guard/clock.ts";
import type { Guard, Lease } from "../src/guard/index.ts";
import { PERMISSIVE_GUARD, ThrottledError, createGuard } from "../src/guard/index.ts";
import { memoryGuardStore } from "../src/guard/store.ts";
import { USER_AGENT } from "../src/source/http.ts";
import { SourceError } from "../src/source/index.ts";
import { PARSER_VERSION, createRobomasterSource, parseTime } from "../src/source/robomaster.ts";
import { T0, fakeForum } from "./crawl-helpers.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/robomaster/${name}.json`, import.meta.url), "utf8"),
  ) as unknown;

async function permissiveGuard(): Promise<Guard> {
  return createGuard({
    sourceId: "robomaster",
    store: memoryGuardStore(),
    clock: fakeClock(T0),
    config: PERMISSIVE_GUARD,
  });
}

/** Records every settle; `acquire` can be told to throttle. */
function spyGuard(options: { throttle?: boolean } = {}) {
  const settles: string[] = [];
  const guard: Guard = {
    async acquire() {
      if (options.throttle) throw new ThrottledError(T0 + 60_000, "circuitOpen");
      settles.push("acquire");
      const lease: Lease = {
        async ok() {
          settles.push("ok");
        },
        async failed(kind, retryAfterSec, message) {
          settles.push(`failed:${kind}:${retryAfterSec}:${message}`);
        },
      };
      return lease;
    },
    allows: () => null,
    snapshot: () => {
      throw new Error("unused");
    },
  };
  return { guard, settles };
}

describe("robomaster listing", () => {
  it("maps list_page.json to ListedArticle", async () => {
    const forum = fakeForum();
    forum.inject({ json: fixture("list_page") });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    const page = await source.listPage(1, 20, "background");
    expect(page.total).toBe(143);
    expect(page.isLast).toBe(true); // 3 < 20: short page
    expect(page.items.map((i) => i.sourceArticleId)).toEqual(["1939253", "1939100", "1938001"]);
    const [a, b, c] = page.items;
    expect(a).toMatchObject({
      title: "自瞄框架开源：插件化视觉系统",
      url: "https://bbs.robomaster.com/article/1939253?source=1",
      author: "RobotPilots",
      isPinned: false,
      introduction: "基于插件的自瞄框架，支持热插拔相机与识别模块。",
      tags: ["视觉/自瞄", "开源"],
      listingPosition: 0,
    });
    expect(a!.publishedAt?.toISOString()).toBe("2026-08-20T06:03:22.000Z"); // offset-less = UTC+8
    expect(b).toMatchObject({ isPinned: true, tags: [], listingPosition: 1 });
    expect(b!.publishedAt?.toISOString()).toBe("2026-08-18T01:00:00.000Z");
    expect(c).toMatchObject({ author: null, publishedAt: null, listingPosition: 2 });
  });

  it("sends rm-wenku's exact request shape", async () => {
    const forum = fakeForum({ pages: [[]], total: 0 });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    await source.listPage(3, 20, "background");
    const req = forum.requests[0]!;
    expect(req.path).toBe("/developers-server/rest/posts/list");
    expect(req.body).toEqual({
      pageSize: 20,
      pageNo: 3,
      filter: { category: "ARTICLE", sortByCreateAt: true, tagIds: [] },
    });
    expect(req.headers["user-agent"]).toBe(USER_AGENT);
    expect(req.headers.accept).toBe("application/json");
    expect(req.init.redirect).toBe("manual");
    expect(req.init.method).toBe("POST");
  });

  it("isLast: short page, or page*size >= total", async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, title: `t${i}` }));
    const forum = fakeForum({ pages: [full, full, full], total: 60 });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    expect((await source.listPage(1, 20, "background")).isLast).toBe(false);
    expect((await source.listPage(3, 20, "background")).isLast).toBe(true);
    expect((await source.listPage(2, 20, "background")).items[0]?.listingPosition).toBe(20);
  });

  it("rejects bad arguments before any request", async () => {
    const forum = fakeForum();
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    await expect(source.listPage(0, 20, "background")).rejects.toMatchObject({
      failure: { kind: "invalid" },
    });
    await expect(source.fetchDetail("../admin", "background")).rejects.toMatchObject({
      failure: { kind: "invalid" },
    });
    expect(forum.requests).toHaveLength(0);
  });

  it("parseTime handles the five formats and garbage", () => {
    expect(parseTime(1755680000000)?.toISOString()).toBe("2025-08-20T08:53:20.000Z");
    expect(parseTime("2026-08-20T14:03:22+08:00")?.toISOString()).toBe("2026-08-20T06:03:22.000Z");
    expect(parseTime("2026-08-20T14:03:22Z")?.toISOString()).toBe("2026-08-20T14:03:22.000Z");
    expect(parseTime("2026-08-20 14:03:22")?.toISOString()).toBe("2026-08-20T06:03:22.000Z");
    expect(parseTime("2026-08-20T14:03:22")?.toISOString()).toBe("2026-08-20T06:03:22.000Z");
    expect(parseTime("2026-08-20")?.toISOString()).toBe("2026-08-19T16:00:00.000Z");
    expect(parseTime("not a date")).toBeNull();
    expect(parseTime("2026-02-30")).toBeNull();
    expect(parseTime(null)).toBeNull();
  });
});

describe("robomaster detail", () => {
  it("maps post_html.json: format, extras folded through extract, parserVersion", async () => {
    const forum = fakeForum();
    forum.inject({ json: fixture("post_html") });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    const d = await source.fetchDetail("1939253", "background");
    expect(forum.requests[0]).toMatchObject({
      path: "/developers-server/rest/posts/info/1939253",
      body: {},
    });
    expect(d.format).toBe("html");
    expect(d.parserVersion).toBe(PARSER_VERSION);
    expect(d.tags).toEqual(["视觉/自瞄"]);
    expect(d.extracted.links.map((l) => [l.url, l.label, l.kind, l.position])).toEqual([
      ["https://github.com/example/frame", "源码", "repository", 0],
      ["https://cdn.example.com/report.pdf", "技术报告.pdf", "download", 1], // fileItems duplicate deduped, first label kept
      ["https://bbs.robomaster.com/article/123", "参考项目", "other", 2],
    ]);
    expect(d.extracted.images.map((i) => [i.url, i.alt])).toEqual([
      ["https://cdn.example.com/diagram.png", "架构图"],
      ["https://cdn.example.com/files/123", "photo.JPG"], // extension-less URL, image by name
    ]);
  });

  it("maps post_markdown.json: MARKDOWN + markdownContent wins over htmlContent", async () => {
    const forum = fakeForum();
    forum.inject({ json: fixture("post_markdown") });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    const d = await source.fetchDetail("1939254", "background");
    expect(d.format).toBe("markdown");
    expect(d.raw.startsWith("## 架构")).toBe(true);
    expect(d.publishedAt?.getTime()).toBe(1755680000000);
    expect(d.extracted.links[0]).toMatchObject({
      url: "https://gitee.com/a/b",
      kind: "repository",
    });
    expect(d.extracted.images[0]).toMatchObject({
      url: "https://cdn.example.com/power.png",
      alt: "功率曲线",
    });
  });

  it("format matrix", async () => {
    const guard = await permissiveGuard();
    const cases: [Record<string, unknown>, "html" | "markdown" | "invalid"][] = [
      [{ contentType: "MARKDOWN", markdownContent: "# a", htmlContent: "<p>b</p>" }, "markdown"],
      [{ contentType: "HTML", markdownContent: "# a", htmlContent: null }, "markdown"],
      [{ contentType: "HTML", markdownContent: "# a", htmlContent: "<p>b</p>" }, "html"],
      [{ contentType: "markdown", markdownContent: "  ", htmlContent: "<p>b</p>" }, "html"],
      [{ contentType: "HTML", markdownContent: null, htmlContent: "" }, "invalid"],
    ];
    for (const [fields, expected] of cases) {
      const forum = fakeForum();
      forum.inject({ json: { success: true, data: { id: 1, title: "t", ...fields } } });
      const source = createRobomasterSource({ fetch: forum.fetch, guard });
      const result = source.fetchDetail("1", "background");
      if (expected === "invalid") {
        await expect(result).rejects.toMatchObject({ failure: { kind: "invalid" } });
      } else {
        expect((await result).format).toBe(expected);
      }
    }
  });

  it("post_missing.json → notFound, not invalid", async () => {
    const forum = fakeForum();
    forum.inject({ json: fixture("post_missing") });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    await expect(source.fetchDetail("404", "background")).rejects.toMatchObject({
      failure: { kind: "notFound" },
    });
  });

  it("a titleless post is invalid", async () => {
    const forum = fakeForum();
    forum.inject({
      json: { success: true, data: { id: 1, title: "  ", htmlContent: "<p>x</p>" } },
    });
    const source = createRobomasterSource({ fetch: forum.fetch, guard: await permissiveGuard() });
    await expect(source.fetchDetail("1", "background")).rejects.toThrow("no title");
  });
});

describe("http client", () => {
  const sourceWith = (forum: ReturnType<typeof fakeForum>, guard: Guard) =>
    createRobomasterSource({ fetch: forum.fetch, guard });

  it("classifies statuses into failures and settles the lease accordingly", async () => {
    const cases: [Parameters<ReturnType<typeof fakeForum>["inject"]>[0], string, string][] = [
      [
        { status: 429, headers: { "retry-after": "900" } },
        "http",
        "failed:rateLimited:900:http 429 (retry-after 900s)",
      ],
      [{ status: 403 }, "forbidden", "failed:forbidden:null:forbidden (http 403)"],
      [{ status: 500 }, "http", "failed:serverError:null:http 500"],
      [
        { throw: new TypeError("fetch failed") },
        "network",
        "failed:network:null:network error: TypeError: fetch failed",
      ],
      [
        { status: 200, body: "<html>captcha</html>", headers: { "content-type": "text/html" } },
        "blocked",
        "failed:blocked:null:blocked: non-JSON 200 response (20 chars)",
      ],
      [
        { status: 200, body: "{not json", headers: { "content-type": "application/json" } },
        "invalid",
        "ok",
      ],
      [{ status: 404 }, "notFound", "ok"],
      [{ status: 400 }, "http", "ok"],
      [{ status: 302, headers: { location: "https://evil.example/" } }, "http", "ok"],
    ];
    for (const [answer, kind, settle] of cases) {
      const forum = fakeForum();
      forum.inject(answer);
      const { guard, settles } = spyGuard();
      const err = await sourceWith(forum, guard)
        .listPage(1, 20, "background")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(SourceError.is(err, kind as never)).toBe(true);
      expect(settles).toEqual(["acquire", settle]);
      expect(forum.requests).toHaveLength(1); // no retries, no redirect follow
    }
  });

  it("a throttled guard sends nothing", async () => {
    const forum = fakeForum();
    const { guard } = spyGuard({ throttle: true });
    await expect(sourceWith(forum, guard).listPage(1, 20, "background")).rejects.toBeInstanceOf(
      ThrottledError,
    );
    expect(forum.requests).toHaveLength(0);
  });

  it("caps the body: declared and streamed", async () => {
    const forum = fakeForum();
    forum.inject({
      status: 200,
      body: "{}",
      headers: { "content-length": String(6 * 1024 * 1024) },
    });
    const { guard, settles } = spyGuard();
    await expect(sourceWith(forum, guard).listPage(1, 20, "background")).rejects.toMatchObject({
      failure: { kind: "tooLarge" },
    });
    expect(settles).toEqual(["acquire", "ok"]);
    const big = fakeForum();
    big.inject({ status: 200, body: "x".repeat(5 * 1024 * 1024 + 1) });
    await expect(sourceWith(big, guard).listPage(1, 20, "background")).rejects.toMatchObject({
      failure: { kind: "tooLarge" },
    });
  });
});
