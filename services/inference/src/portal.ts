import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
};
export async function servePortal(
  directory: string,
  path: string,
  method: string,
  res: ServerResponse,
) {
  if (!["GET", "HEAD"].includes(method)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const root = resolve(directory);
  let file = resolve(root, "." + path);
  if (!file.startsWith(root + sep) || path.split("/").some((part) => part.startsWith("."))) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    if (extname(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    file = resolve(root, "index.html");
  }
  const data = await readFile(file);
  res.writeHead(200, {
    "content-type": mime[extname(file)] ?? "application/octet-stream",
    "cache-control": path.startsWith("/static/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    ...(path === "/portal-source.tar.gz"
      ? { "content-disposition": 'attachment; filename="herkules-portal-source.tar.gz"' }
      : {}),
  });
  res.end(method === "HEAD" ? undefined : data);
}
