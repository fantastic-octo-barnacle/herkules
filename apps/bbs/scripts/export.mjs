#!/usr/bin/env node

/**
 * Standalone RM Wenku exporter. Requires Node 22+ and no packages.
 *
 * Usage:
 *   node export.mjs <directory> [--origin <url>] [--concurrency N]
 *
 * Article JSON is refreshed on every run. Image files have deterministic names
 * derived from their source URLs, so rerunning the same directory reuses
 * complete files and retries missing or failed downloads.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_ORIGIN = "https://bbs.herkules.dev";
const PAGE_SIZE = 100;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_STALL_MS = 30_000;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const ARTICLE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const USAGE = "usage: node export.mjs <directory> [--origin <url>] [--concurrency N]";

export async function exportLibrary(options, dependencies = {}) {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? (() => {});
  const origin = normalizeOrigin(options.origin ?? DEFAULT_ORIGIN);
  const outputDir = resolve(options.outputDir);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new TypeError("concurrency must be an integer from 1 to 32");
  }

  const report = {
    startedAt: now().toISOString(),
    articleFiles: [],
    articleFailures: [],
    imageReferences: 0,
    imageFailures: [],
  };
  const downloads = new Map();
  const assets = new Map();
  const seenCursors = new Set();
  await mkdir(resolve(outputDir, "articles"), { recursive: true });
  await mkdir(resolve(outputDir, "images"), { recursive: true });

  const [tags, status] = await Promise.all([
    getJson(fetch, apiUrl(origin, "/api/tags")),
    getJson(fetch, apiUrl(origin, "/api/status")),
  ]);
  await Promise.all([
    writeJson(resolve(outputDir, "tags.json"), tags),
    writeJson(resolve(outputDir, "status.json"), status),
  ]);
  await writeManifest(outputDir, origin, report, assets, false, now());

  let cursor = null;
  let pageNumber = 0;
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("/api/articles repeated a cursor");
      seenCursors.add(cursor);
    }
    const page = await getJson(
      fetch,
      apiUrl(origin, "/api/articles", {
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      }),
    );
    assertPage(page);
    pageNumber += 1;
    await mapLimit(page.items, concurrency, async ({ id }) => {
      try {
        const [article, ai] = await Promise.all([
          getJson(fetch, apiUrl(origin, `/api/articles/${encodeURIComponent(id)}`)),
          getJson(fetch, apiUrl(origin, `/api/articles/${encodeURIComponent(id)}/ai`)),
        ]);
        if (!article || !Array.isArray(article.images)) {
          throw new Error("article response has no images array");
        }
        const images = [];
        for (const image of article.images) {
          report.imageReferences += 1;
          const asset = await assetFor(image.url, outputDir, fetch, downloads, assets);
          images.push({ ...image, asset });
          if (asset.status === "failed") {
            report.imageFailures.push({
              id: `${id}:${String(image.position)}`,
              articleId: id,
              url: image.url,
              error: asset.error,
            });
          }
        }
        const file = `articles/${id}.json`;
        await writeJson(resolve(outputDir, file), { article, ai, images });
        report.articleFiles.push(file);
      } catch (error) {
        report.articleFailures.push({ id, error: messageOf(error) });
      }
    });
    cursor = page.nextCursor;
    log(
      `page ${String(pageNumber)}: ${String(page.items.length)} articles, ${String(report.articleFiles.length)} exported`,
    );
    await writeManifest(outputDir, origin, report, assets, false, now());
  } while (cursor);

  const manifest = manifestOf(origin, report, assets, true, now());
  await writeJson(resolve(outputDir, "manifest.json"), manifest);
  return manifest;
}

async function assetFor(source, outputDir, fetch, downloads, assets) {
  let download = downloads.get(source);
  if (!download) {
    download = downloadImage(source, outputDir, fetch)
      .catch((error) => ({
        url: source,
        file: null,
        bytes: null,
        status: "failed",
        error: messageOf(error),
      }))
      .then((asset) => {
        assets.set(source, asset);
        return asset;
      });
    downloads.set(source, download);
  }
  return download;
}

async function downloadImage(source, outputDir, fetch) {
  const sourceUrl = new URL(source);
  if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") {
    throw new Error(`unsupported image URL scheme: ${sourceUrl.protocol}`);
  }
  const digest = createHash("sha256").update(source).digest("hex");
  const extension = imageExtension(sourceUrl);
  const relativeFile = `images/${digest.slice(0, 2)}/${digest}${extension}`;
  const target = resolve(outputDir, relativeFile);
  const existing = await fileSize(target);
  if (existing !== null && existing > 0) {
    return { url: source, file: relativeFile, bytes: existing, status: "reused" };
  }
  if (existing === 0) await rm(target, { force: true });

  // Abort when no bytes arrive for a while, not on total transfer time: a large image on a
  // slow link must still finish, or every rerun would restart it from zero and fail again.
  const controller = new AbortController();
  let stall = null;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      controller.abort(new Error(`no data for ${String(IMAGE_STALL_MS)} ms`));
    }, IMAGE_STALL_MS);
  };
  armStall();
  try {
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": "Herkules-BBS-Export/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`);
    if (!response.body) throw new Error("response has no body");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      contentType !== "application/octet-stream"
    ) {
      throw new Error(`unexpected content type ${contentType}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`image exceeds ${String(MAX_IMAGE_BYTES)} bytes`);
    }

    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        armStall();
        bytes += chunk.length;
        callback(
          bytes > MAX_IMAGE_BYTES
            ? new Error(`image exceeds ${String(MAX_IMAGE_BYTES)} bytes`)
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        Readable.from(response.body),
        limit,
        createWriteStream(temporary, { flags: "wx" }),
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { url: source, file: relativeFile, bytes, status: "stored" };
  } finally {
    clearTimeout(stall);
  }
}

function manifestOf(origin, report, assets, complete, finishedAt) {
  const values = [...assets.values()];
  const articleFailures = [...report.articleFailures];
  const imageFailures = [...report.imageFailures];
  return {
    version: 1,
    source: origin,
    startedAt: report.startedAt,
    finishedAt: complete ? finishedAt.toISOString() : null,
    complete,
    ok: complete && articleFailures.length === 0 && imageFailures.length === 0,
    articles: {
      exported: report.articleFiles.length,
      files: [...report.articleFiles].sort((a, b) => a.localeCompare(b)),
      failed: articleFailures,
    },
    images: {
      references: report.imageReferences,
      assets: values.length,
      stored: values.filter((asset) => asset.status === "stored").length,
      reused: values.filter((asset) => asset.status === "reused").length,
      failed: imageFailures,
    },
  };
}

async function writeManifest(outputDir, origin, report, assets, complete, now) {
  await writeJson(
    resolve(outputDir, "manifest.json"),
    manifestOf(origin, report, assets, complete, now),
  );
}

function imageExtension(url) {
  const extension = extname(url.pathname).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? extension : ".img";
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("origin must use http or https");
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function apiUrl(origin, path, query = {}) {
  const url = new URL(path, `${origin}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function getJson(fetch, url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url.pathname}: ${String(response.status)} ${body || response.statusText}`);
  }
  return response.json();
}

function assertPage(page) {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.some((item) => typeof item?.id !== "string" || !ARTICLE_ID.test(item.id)) ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string")
  ) {
    throw new Error("/api/articles returned an invalid page");
  }
}

async function mapLimit(values, concurrency, visit) {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await visit(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        origin: { type: "string" },
        concurrency: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`bbs export: ${messageOf(error)}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    console.log(
      "Exports article JSON, AI records, tags, status, and image files from the public API.",
    );
    console.log(`Default origin: ${DEFAULT_ORIGIN}`);
    console.log("Rerun the same directory to reuse downloaded images and retry failures.");
    return 0;
  }
  const directory = parsed.positionals[0];
  if (!directory || parsed.positionals.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const concurrency = Number(parsed.values.concurrency ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    console.error("bbs export: --concurrency must be an integer from 1 to 32");
    return 2;
  }

  const origin = parsed.values.origin ?? DEFAULT_ORIGIN;
  const outputDir = resolve(directory);
  console.log(`bbs export  source=${origin}  output=${outputDir}`);
  try {
    const report = await exportLibrary(
      { origin, outputDir, concurrency },
      { ...dependencies, log: dependencies.log ?? console.log },
    );
    console.log(
      `exported ${String(report.articles.exported)} articles and ${String(report.images.assets)} images (${String(report.images.reused)} reused)`,
    );
    if (!report.ok) {
      console.error(
        `bbs export: incomplete: ${String(report.articles.failed.length)} articles and ${String(report.images.failed.length)} image references failed`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`bbs export: ${messageOf(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli();
}
