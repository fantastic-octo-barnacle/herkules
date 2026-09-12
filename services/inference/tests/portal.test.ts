import { expect, test } from "vite-plus/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { servePortal } from "../src/portal.ts";

test("portal serves the SPA and corresponding source but excludes hidden and missing assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portal-test-"));
  await writeFile(join(dir, "index.html"), "<h1>Portal</h1>");
  await writeFile(join(dir, ".build-id"), "private build metadata");
  await writeFile(join(dir, "portal-source.tar.gz"), "source fixture");
  const server = createServer((req, res) => {
    void servePortal(dir, req.url!, req.method!, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect(await (await fetch(url + "/profile")).text()).toContain("Portal");
    expect((await fetch(url + "/.build-id")).status).toBe(404);
    expect((await fetch(url + "/missing.js")).status).toBe(404);
    const source = await fetch(url + "/portal-source.tar.gz");
    expect(source.headers.get("content-disposition")).toContain("attachment");
    expect(await source.text()).toBe("source fixture");
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
