import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

// @ts-expect-error The standalone script intentionally ships without TypeScript declarations.
import { exportLibrary } from "../scripts/export.mjs";

const ORIGIN = "https://bbs.example";
const IDS = ["01J00000000000000000000001", "01J00000000000000000000002"];
const IMAGE = "https://cdn.example/image.png";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("standalone BBS export", () => {
  it("paginates articles, deduplicates images, and resumes completed downloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bbs-export-"));
    directories.push(directory);
    let imageRequests = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.href === IMAGE) {
        imageRequests += 1;
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname === "/api/tags") return Response.json({ items: [], groups: [], total: 2 });
      if (url.pathname === "/api/status") return Response.json({ articles: { total: 2 } });
      if (url.pathname === "/api/articles" && !url.searchParams.has("cursor")) {
        return Response.json({ items: [{ id: IDS[0] }], nextCursor: "next" });
      }
      if (url.pathname === "/api/articles" && url.searchParams.get("cursor") === "next") {
        return Response.json({ items: [{ id: IDS[1] }], nextCursor: null });
      }
      const ai = url.pathname.match(/^\/api\/articles\/([^/]+)\/ai$/)?.[1];
      if (ai) return Response.json({ articleId: ai, status: "pending" });
      const article = url.pathname.match(/^\/api\/articles\/([^/]+)$/)?.[1];
      if (article) {
        return Response.json({
          id: article,
          title: `Article ${article}`,
          images: [{ url: IMAGE, alt: "diagram", position: 0 }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const first = await exportLibrary(
      { origin: ORIGIN, outputDir: directory, concurrency: 2 },
      { fetch },
    );
    expect(first).toMatchObject({
      complete: true,
      ok: true,
      articles: { exported: 2, failed: [] },
      images: { references: 2, assets: 1, stored: 1, reused: 0, failed: [] },
    });
    expect(imageRequests).toBe(1);

    const exported = JSON.parse(await readFile(join(directory, `articles/${IDS[0]}.json`), "utf8"));
    expect(exported.images[0].asset).toMatchObject({ status: "stored", bytes: 4 });
    expect(await readFile(join(directory, exported.images[0].asset.file))).toEqual(
      Buffer.from([137, 80, 78, 71]),
    );

    const second = await exportLibrary(
      { origin: ORIGIN, outputDir: directory, concurrency: 2 },
      { fetch },
    );
    expect(second.images).toMatchObject({ assets: 1, stored: 0, reused: 1, failed: [] });
    expect(imageRequests).toBe(1);
  });
});
