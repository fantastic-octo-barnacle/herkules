import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { assetFiles } from "./assets.mjs";
import { routes } from "./release.mjs";
import { createApi } from "../../../services/web/src/api.ts";

/** Which production route a URL would match first, most-specific prefix first. */
function matchRoute(url) {
  const { host, pathname } = new URL(url);
  const candidates = routes
    .filter((route) => {
      const [patternHost, patternPath] = route.pattern.split("/");
      if (patternHost !== host) return false;
      const prefix = route.pattern.slice(patternHost.length).replace(/\*$/, "");
      return pathname.startsWith(prefix);
    })
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return candidates[0];
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = new URL("./dist/", import.meta.url);

async function verify(name, port, check) {
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      `tools/deploy/cloudflare/${name}.json`,
      "--port",
      String(port),
      "--local",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        await fetch(origin, { signal: AbortSignal.timeout(500) });
        ready = true;
        break;
      } catch {
        await setTimeout(200);
      }
    }
    assert.ok(ready, `Wrangler did not start: ${output}`);
    await check(origin);
    console.log(`${name}: local Workers runtime checks passed`);
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error("Could not stop Wrangler:", error);
        process.exitCode = 1;
      }
    }
  }
}

async function verifyAsset(origin, name) {
  const files = await assetFiles(fileURLToPath(new URL(`${name}/assets/`, directory)));
  for (const file of files) {
    const response = await fetch(`${origin}/assets/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-herkules-delivery"), "cloudflare-assets-experiment");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(new URL(`${name}/assets/${file}`, directory)),
    );
  }
}

await verify("platform", 18787, async (origin) => {
  // A static-only preview answers this API path with HTML. The real browser
  // client must reject it, rather than exposing a fake session to React.
  const api = createApi((path, init) => {
    if (typeof path !== "string") throw new Error("Expected a relative API path");
    return fetch(new URL(path, origin), init);
  });
  await assert.rejects(api.session(), { code: "invalid_response" });
  for (const path of ["/", "/login?next=%2Fsettings", "/settings", "/admin/members"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.match(await response.text(), /<div id="root"><\/div>/);
  }
  const redirect = await fetch(`${origin}/ai`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://ai-portal.herkules.dev/");
  await verifyAsset(origin, "platform");
});

await verify("bbs-assets", 18788, async (origin) => {
  await verifyAsset(origin, "bbs-assets");
  const document = await readFile(new URL("bbs-assets/index.html", directory), "utf8");
  for (const path of [
    "/",
    "/index.html",
    "/search?q=edge",
    "/tags",
    "/status",
    "/about",
    "/account",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-herkules-delivery"), "cloudflare-assets-experiment");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), document);
  }
  for (const file of ["favicon.svg", "robots.txt"]) {
    const response = await fetch(`${origin}/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(new URL(`bbs-assets/${file}`, directory)),
    );
  }
  const head = await fetch(`${origin}/about`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  // Production routes: BBS dynamic prefixes bypass the Worker (origin), while
  // everything else on the BBS host rides the asset-only Worker. Matched against
  // the real route table this upload ships with, including wildcards and
  // query strings.
  const edge = ["/", "/search?q=edge", "/tags", "/about", "/assets/missing.js", "/anything/else"];
  for (const path of edge) {
    const match = matchRoute(`https://bbs.herkules.dev${path}`);
    assert.ok(match?.script, `${path} must reach the BBS Worker`);
  }
  const originOnly = [
    "/api/status",
    "/api/articles?page=2",
    "/login?next=%2Faccount",
    "/callback?code=x",
    "/logout",
    "/healthz",
    "/mcp/bbs",
    "/articles/RM2025-001",
    "/articles/RM2025-001/content",
    "/kb",
    "/kb/some-entity",
  ];
  for (const path of originOnly) {
    const match = matchRoute(`https://bbs.herkules.dev${path}`);
    assert.equal(match?.script ?? undefined, undefined, `${path} must bypass the BBS Worker`);
  }
  // Platform bypasses keep their origin routing.
  for (const path of [
    "/auth/healthz",
    "/.well-known/oauth-authorization-server/auth",
    "/mcp/bbs",
  ]) {
    const match = matchRoute(`https://herkules.dev${path}`);
    assert.equal(match?.script ?? undefined, undefined, `${path} must bypass the platform Worker`);
  }
  // An asset-only preview has no zone bypasses: fallback can return HTML for
  // API/metadata paths too. Production route tests pin those to the origin.
  // Assert the upload inventory itself, not a misleading fallback HTTP status.
  const files = await assetFiles(fileURLToPath(new URL("bbs-assets/", directory)));
  assert.ok(
    files.every(
      (file) =>
        file.startsWith("assets/") ||
        ["index.html", "favicon.svg", "robots.txt", "_headers"].includes(file),
    ),
  );
});
