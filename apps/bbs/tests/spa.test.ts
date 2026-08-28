/** The static handler over a temp build dir and the fake library: injection, 404 shell, asset caching, API paths never HTML. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewerEnv } from "@herkules/oauth-client/hono";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { IMMUTABLE, SHORT_LIVED, createSpaHandler } from "../src/spa/static.ts";
import { APP_ORIGIN, FAKE, fakeLibrary } from "./helpers.ts";

describe("createSpaHandler", () => {
  let app: Hono<ViewerEnv>;
  let library: ReturnType<typeof fakeLibrary>;
  let plain: string;
  const get = (path: string) => app.request(`${APP_ORIGIN}${path}`);

  beforeAll(async () => {
    const webDir = await mkdtemp(join(tmpdir(), "bbs-spa-"));
    plain = await readFile(new URL("./fixtures/index.html", import.meta.url), "utf8");
    await writeFile(join(webDir, "index.html"), plain);
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "assets", "index-DEADBEEF.js"), "console.log(1)");
    await writeFile(join(webDir, "robots.txt"), "User-agent: *\n");
    library = fakeLibrary();
    app = new Hono<ViewerEnv>();
    app.get("/api/ping", (c) => c.json({ pong: true }));
    const spa = await createSpaHandler({ webDir, library, appOrigin: APP_ORIGIN });
    expect(spa.template).not.toBeNull();
    spa.mount(app);
  });

  it("serves the plain shell for routes without metadata", async () => {
    const res = await get("/search?q=x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(plain);
  });

  it("injects the article head from a two-column read and escapes it", async () => {
    const res = await get(`/articles/${FAKE.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;&amp;&quot;quoted&quot;&lt;/b&gt; · RM 文库</title>");
    expect(html).not.toContain("<b>&");
    expect(html).toContain(`<meta property="og:url" content="${APP_ORIGIN}/articles/${FAKE.id}">`);
    expect(html).not.toContain("<title>RM 文库</title>");
    expect(library.calls).toEqual(["head"]); // never article()
  });

  it("injects the entity head", async () => {
    const res = await get(`/kb/${encodeURIComponent(FAKE.entityName)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<title>${FAKE.entityName} · RM 文库</title>`);
  });

  it("answers 404 with the plain shell for an unknown or malformed id", async () => {
    for (const path of [`/articles/${FAKE.unknownId}`, "/articles/not-a-ulid", "/kb/nobody"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toBe(plain);
    }
  });

  it("never turns an API or MCP path into a document", async () => {
    expect(await (await get("/api/ping")).json()).toEqual({ pong: true });
    const miss = await get("/api/nope");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ error: "not_found" });
    expect((await get("/mcp/other")).status).toBe(404);
  });

  it("serves hashed assets as immutable and root files as short-lived", async () => {
    const asset = await get("/assets/index-DEADBEEF.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(await asset.text()).toBe("console.log(1)");
    const robots = await get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("cache-control")).toBe(SHORT_LIVED);
  });

  it("is disabled entirely without a webDir", async () => {
    const off = await createSpaHandler({ webDir: null, library, appOrigin: APP_ORIGIN });
    expect(off.template).toBeNull();
    const bare = new Hono<ViewerEnv>();
    off.mount(bare);
    expect((await bare.request(`${APP_ORIGIN}/`)).status).toBe(404);
  });

  it("refuses to boot on a build without the markers", async () => {
    const webDir = await mkdtemp(join(tmpdir(), "bbs-spa-bad-"));
    await writeFile(join(webDir, "index.html"), "<html><head><title>x</title></head></html>");
    await expect(createSpaHandler({ webDir, library, appOrigin: APP_ORIGIN })).rejects.toThrow(
      "<!--bbs:head-->",
    );
  });
});
