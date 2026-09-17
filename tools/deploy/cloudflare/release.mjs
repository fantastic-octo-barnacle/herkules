import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { assetFiles } from "./assets.mjs";
import { validateRelease } from "../release.mjs";

// Backend bypass prefixes are installed before either BBS catch-all becomes
// reachable. Broad prefixes cover bare paths, descendants and query strings;
// the entire /kb prefix is deliberately conservative so knowledge-base
// documents always keep origin-injected link-preview metadata and 404
// semantics. Article/KB metadata therefore stays on the origin even though the
// catch-all Worker now serves the whole public client and SPA fallback.
export const bbsBypassPrefixes = [
  "/api*",
  "/login*",
  "/callback*",
  "/logout*",
  "/healthz*",
  "/mcp*",
  "/articles*",
  "/kb*",
];

export const routes = [
  { pattern: "herkules.dev/auth*" },
  { pattern: "herkules.dev/.well-known*" },
  { pattern: "herkules.dev/mcp*" },
  ...bbsBypassPrefixes.map((prefix) => ({ pattern: `bbs.herkules.dev${prefix}` })),
  { pattern: "herkules.dev/*", script: "herkules-platform" },
  // Kept for backward compatibility with the legacy asset-only deployment.
  { pattern: "bbs.herkules.dev/assets/*", script: "herkules-bbs-assets" },
  { pattern: "bbs.herkules.dev/*", script: "herkules-bbs-assets" },
];

// Never replace a route owned by another application. Bypass rules are retained
// when disabled: they are harmless and may have existed before this deployment.
export function checkRoutes(existing) {
  for (const desired of routes) {
    const found = existing.find((route) => route.pattern === desired.pattern);
    if (found && (found.script || undefined) !== desired.script) {
      throw new Error(`Conflicting Cloudflare route: ${desired.pattern}`);
    }
  }
}

export async function detach(api) {
  const existing = await api("GET", "");
  checkRoutes(existing);
  for (const route of existing) {
    if (
      routes.some(
        (desired) =>
          desired.script && desired.pattern === route.pattern && desired.script === route.script,
      )
    ) {
      await api("DELETE", `/${route.id}`);
    }
  }
  const remaining = await api("GET", "");
  if (
    remaining.some((route) =>
      routes.some((desired) => desired.script && desired.pattern === route.pattern),
    )
  ) {
    throw new Error("Cloudflare asset routes remain attached");
  }
}

export async function attach(api) {
  const existing = await api("GET", "");
  checkRoutes(existing);
  // All backend/document exceptions must exist before either catch-all is activated.
  for (const desired of routes) {
    if (!existing.some((route) => route.pattern === desired.pattern)) {
      await api("POST", "", desired);
    }
  }
}

export async function activate({ api, upload, verify }) {
  try {
    await upload();
    await attach(api);
    await verify();
    return "edge";
  } catch (error) {
    // The VPS has already committed this release. Keep its exact frontend usable
    // if upload/activation fails; do not claim that its backend was rolled back.
    await detach(api);
    console.warn(`Cloudflare delivery unavailable; serving from origin: ${error.message}`);
    return "origin";
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

export function imageAssets(release) {
  validateRelease(release);
  return [
    { name: "platform", image: release.images.caddy, path: "/srv" },
    { name: "bbs", image: release.images.bbs, path: "/app/dist/client" },
  ];
}

async function extract(image, path, target) {
  run("docker", ["pull", "--platform", "linux/amd64", image]);
  const container = run("docker", ["create", "--platform", "linux/amd64", image]).trim();
  try {
    await mkdir(target, { recursive: true });
    run("docker", ["cp", `${container}:${path}/.`, target]);
  } finally {
    run("docker", ["rm", container]);
  }
}

// Proxied HTML can be rewritten by zone features (e.g. the Web Analytics beacon),
// so a document matches the release when it loads every hashed asset its
// built index.html does, rather than byte-for-byte.
export async function matchesReleaseDocument(html, indexPath) {
  const expected = (await readFile(indexPath, "utf8")).match(/\/assets\/[^"'\s>]+/g) ?? [];
  if (expected.length === 0) throw new Error(`No hashed assets referenced by ${indexPath}`);
  return expected.every((asset) => html.includes(asset));
}

export async function verifyPublic(output, fetchImpl = fetch) {
  for (const [name, origin] of [
    ["platform", "https://herkules.dev"],
    ["bbs-assets", "https://bbs.herkules.dev"],
  ]) {
    const files = await assetFiles(join(output, name, "assets"));
    for (const file of files) {
      const response = await fetchImpl(
        `${origin}/assets/${file.split("/").map(encodeURIComponent).join("/")}`,
        {
          signal: AbortSignal.timeout(15000),
        },
      );
      const expected = await readFile(join(output, name, "assets", file));
      if (
        !response.ok ||
        response.headers.get("x-herkules-delivery") !== "cloudflare-assets-experiment" ||
        !Buffer.from(await response.arrayBuffer()).equals(expected)
      ) {
        throw new Error(`Asset verification failed: ${name}/${file}`);
      }
    }
  }
  const document = await fetchImpl("https://herkules.dev/", { signal: AbortSignal.timeout(15000) });
  if (
    document.headers.get("x-herkules-delivery") !== "cloudflare-assets-experiment" ||
    !(await matchesReleaseDocument(await document.text(), join(output, "platform/index.html")))
  ) {
    throw new Error("Platform document does not match release");
  }
  for (const path of ["/", "/search?q=edge"]) {
    const response = await fetchImpl(`https://bbs.herkules.dev${path}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (
      response.status !== 200 ||
      response.headers.get("x-herkules-delivery") !== "cloudflare-assets-experiment" ||
      !response.headers.get("content-type")?.startsWith("text/html") ||
      response.headers.get("cache-control") !== "no-cache" ||
      response.headers.get("x-content-type-options") !== "nosniff" ||
      !(await matchesReleaseDocument(await response.text(), join(output, "bbs-assets/index.html")))
    ) {
      throw new Error(`BBS document does not match release: ${path}`);
    }
  }
  for (const [path, valid] of [
    ["/api/viewer", (body) => body?.viewer === null],
    ["/healthz", (body) => body?.ok === true],
  ]) {
    const response = await fetchImpl(`https://bbs.herkules.dev${path}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (
      response.status !== 200 ||
      response.headers.has("x-herkules-delivery") ||
      !response.headers.get("content-type")?.startsWith("application/json") ||
      !valid(await response.json())
    ) {
      throw new Error(`BBS bypass failed: ${path}`);
    }
  }
  // Not a ULID: guaranteed invalid without looking up or touching a real article.
  const missingArticle = await fetchImpl(
    "https://bbs.herkules.dev/articles/release-check-invalid",
    {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (
    missingArticle.status !== 404 ||
    missingArticle.headers.has("x-herkules-delivery") ||
    !missingArticle.headers.get("content-type")?.startsWith("text/html")
  ) {
    throw new Error("BBS article document bypass failed");
  }
  const health = await fetchImpl("https://herkules.dev/auth/healthz", {
    signal: AbortSignal.timeout(15000),
  });
  if (!health.ok || !(await health.json()).ok) throw new Error("Auth bypass failed");
  const internal = await fetchImpl("https://herkules.dev/auth/internal/ai-membership", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["release-check"] }),
    signal: AbortSignal.timeout(15000),
  });
  if (internal.status !== 404) throw new Error("Internal auth route is exposed");
  const discovery = await fetchImpl(
    "https://herkules.dev/.well-known/oauth-authorization-server/auth",
    { signal: AbortSignal.timeout(15000) },
  );
  if (!discovery.ok || !(await discovery.json()).issuer) throw new Error("Discovery bypass failed");
  const mcp = await fetchImpl("https://herkules.dev/mcp/bbs", {
    signal: AbortSignal.timeout(15000),
  });
  if (mcp.status !== 401 || !mcp.headers.get("www-authenticate"))
    throw new Error("MCP bypass failed");
}

async function main() {
  if (process.env.CLOUDFLARE_ASSETS_ENABLED !== "true") {
    console.log("Cloudflare asset deployment is disabled");
    return;
  }
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}/workers/routes`;
  const api = async (method, suffix, body) => {
    const response = await fetch(endpoint + suffix, {
      method,
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok || !data.success)
      throw new Error(`Cloudflare routes API failed (${response.status})`);
    return data.result;
  };
  if (process.argv[2] === "detach") {
    await detach(api);
    return;
  }
  if (process.argv[2] !== "deploy" || !process.argv[3])
    throw new Error("usage: release.mjs detach | deploy <release.json>");
  const release = validateRelease(JSON.parse(await readFile(process.argv[3], "utf8")));
  const working = await mkdtemp(join(tmpdir(), "herkules-edge-"));
  const output = join(working, "assets");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    const delivery = await activate({
      api,
      upload: async () => {
        for (const asset of imageAssets(release)) {
          await extract(asset.image, asset.path, join(working, asset.name));
        }
        run(process.execPath, [join(root, "tools/deploy/cloudflare/prepare.mjs")], {
          env: {
            ...process.env,
            EDGE_OUTPUT: output,
            EDGE_PLATFORM_SOURCE: join(working, "platform"),
            EDGE_BBS_SOURCE: join(working, "bbs"),
          },
          stdio: "inherit",
        });
        for (const name of ["platform", "bbs-assets"]) {
          const config = JSON.parse(
            await readFile(join(root, "tools/deploy/cloudflare", `${name}.json`), "utf8"),
          );
          config.name = `herkules-${name}`;
          config.workers_dev = false;
          config.assets.directory = join(output, name);
          delete config.$schema;
          const path = join(working, `${name}.json`);
          await writeFile(path, JSON.stringify(config));
          run(
            process.execPath,
            [join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", path],
            { stdio: "inherit" },
          );
        }
      },
      verify: async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await verifyPublic(output);
            return;
          } catch (error) {
            if (attempt === 5) throw error;
            await setTimeout(5000);
          }
        }
      },
    });
    const receipt = {
      sourceSha: release.sourceSha,
      images: { caddy: release.images.caddy, bbs: release.images.bbs },
      delivery,
    };
    await writeFile("edge-delivery.json", `${JSON.stringify(receipt, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\nStatic asset delivery: **${delivery}** (see edge-delivery.json).\n`,
      );
    if (delivery === "origin")
      console.log(
        "::warning::Workers rollout failed; this release is served by the VPS. Retry the deployment to restore edge delivery.",
      );
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
