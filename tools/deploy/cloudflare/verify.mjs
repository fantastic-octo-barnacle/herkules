import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { assetFiles } from "./assets.mjs";
import { createApi } from "../../../services/web/src/api.ts";

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
  for (const path of [
    "/",
    "/index.html",
    "/articles/1",
    "/api/status",
    "/main.mjs",
    "/assets/missing.js",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, `BBS asset preview must not serve ${path}`);
  }
});
