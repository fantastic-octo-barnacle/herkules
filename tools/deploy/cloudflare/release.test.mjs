import assert from "node:assert/strict";
import test from "node:test";
import { routes, attach, detach, activate, imageAssets } from "./release.mjs";

function mock(initial = [], fail = () => false) {
  let records = structuredClone(initial);
  const calls = [];
  const api = async (method, suffix, body) => {
    calls.push({ method, suffix, body });
    if (fail(method, body)) throw new Error("simulated API failure");
    if (method === "GET") return structuredClone(records);
    if (method === "POST") records.push({ ...body, id: `id-${calls.length}` });
    if (method === "DELETE") records = records.filter((r) => `/${r.id}` !== suffix);
  };
  return { api, calls, records: () => records };
}

test("installs all backend bypasses before activating either Worker", async () => {
  const m = mock();
  await attach(m.api);
  assert.deepEqual(
    m.calls.filter((c) => c.method === "POST").map((c) => c.body),
    routes,
  );
  await attach(m.api);
  assert.equal(m.calls.filter((c) => c.method === "POST").length, 5);
});

test("detaches only owned asset routes and preserves existing bypasses and unrelated routes", async () => {
  const unrelated = { id: "other", pattern: "status.herkules.dev/*", script: "monitor" };
  const m = mock([...routes.map((r, i) => ({ ...r, id: `${i}` })), unrelated]);
  await detach(m.api);
  assert.deepEqual(m.records(), [
    ...routes.slice(0, 3).map((r, i) => ({ ...r, id: `${i}` })),
    unrelated,
  ]);
});

test("conflicting application routes stop before mutation", async () => {
  const m = mock([{ id: "foreign", pattern: "herkules.dev/*", script: "someone-else" }]);
  await assert.rejects(detach(m.api), /Conflicting/);
  await assert.rejects(attach(m.api), /Conflicting/);
  assert.ok(m.calls.every((c) => c.method === "GET"));
});

test("upload failure keeps the committed origin release available", async () => {
  const m = mock();
  const delivery = await activate({
    api: m.api,
    upload: async () => {
      throw new Error("upload failed");
    },
    verify: async () => assert.fail("must not verify"),
  });
  assert.equal(delivery, "origin");
  assert.equal(m.records().length, 0);
});

test("partial route activation is undone if second Worker activation fails", async () => {
  const m = mock([], (method, body) => method === "POST" && body?.script === "herkules-bbs-assets");
  assert.equal(
    await activate({ api: m.api, upload: async () => {}, verify: async () => assert.fail() }),
    "origin",
  );
  assert.ok(m.records().every((r) => !r.script));
});

test("failed public verification removes both Worker routes", async () => {
  const m = mock();
  assert.equal(
    await activate({
      api: m.api,
      upload: async () => {},
      verify: async () => {
        throw new Error("wrong asset bytes");
      },
    }),
    "origin",
  );
  assert.ok(m.records().every((r) => !r.script));
});

test("cleanup failure is fatal, never reported as successful origin fallback", async () => {
  const m = mock([], (method) => method === "DELETE");
  await assert.rejects(
    activate({
      api: m.api,
      upload: async () => {},
      verify: async () => {
        throw new Error("verification failed");
      },
    }),
    /simulated API failure/,
  );
});

test("successful rollout reports edge delivery only after verification", async () => {
  const m = mock();
  assert.equal(
    await activate({
      api: m.api,
      upload: async () => assert.equal(m.records().length, 0),
      verify: async () => assert.equal(m.records().length, 5),
    }),
    "edge",
  );
});

test("component rollback uses each selected image digest, never the release source checkout", () => {
  const ref = (name, digit) => `ghcr.io/team/${name}@sha256:${digit.repeat(64)}`;
  const release = {
    schemaVersion: 1,
    sourceSha: "a".repeat(40),
    createdAt: new Date().toISOString(),
    reason: "rollback-component",
    parentRelease: null,
    images: {
      auth: ref("auth", "1"),
      bbs: ref("bbs", "2"),
      caddy: ref("caddy", "3"),
      backup: ref("backup", "4"),
    },
    config: Object.fromEntries(
      ["compose", "caddy", "gatus", "apply"].map((key) => [key, `sha256:${"a".repeat(64)}`]),
    ),
  };
  assert.deepEqual(imageAssets(release), [
    { name: "platform", image: release.images.caddy, path: "/srv" },
    { name: "bbs", image: release.images.bbs, path: "/app/dist/client" },
  ]);
  release.images.bbs = ref("bbs", "5");
  assert.equal(imageAssets(release)[1].image, release.images.bbs);
  assert.equal(imageAssets(release)[0].image, release.images.caddy);
  release.images.bbs = "ghcr.io/team/bbs:latest";
  assert.throws(() => imageAssets(release), /invalid/);
});

test("public verification checks nested assets and probes the actual POST-only internal endpoint", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { verifyPublic } = await import("./release.mjs");
  const output = await mkdtemp(join(tmpdir(), "edge-verification-"));
  const calls = [];
  const bytes = new Map();
  try {
    for (const [name, host] of [
      ["platform", "herkules.dev"],
      ["bbs-assets", "bbs.herkules.dev"],
    ]) {
      await mkdir(join(output, name, "assets/fonts"), { recursive: true });
      for (const file of ["main.js", "fonts/team font.woff2"]) {
        await writeFile(join(output, name, "assets", file), `${name}/${file}`);
        bytes.set(
          `https://${host}/assets/${file.split("/").map(encodeURIComponent).join("/")}`,
          `${name}/${file}`,
        );
      }
    }
    await writeFile(join(output, "platform/index.html"), "<html>platform</html>");
    bytes.set("https://herkules.dev/", "<html>platform</html>");
    let internalStatus = 404;
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (bytes.has(url))
        return new Response(bytes.get(url), {
          headers: { "x-herkules-delivery": "cloudflare-assets-experiment" },
        });
      if (url.endsWith("/auth/healthz")) return Response.json({ ok: true });
      if (url.endsWith("/ai-membership")) {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(init.body), { ids: ["release-check"] });
        return new Response(null, { status: internalStatus });
      }
      if (url.includes("/.well-known/"))
        return Response.json({ issuer: "https://herkules.dev/auth" });
      if (url.endsWith("/mcp/bbs"))
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
      throw new Error(`Unexpected request: ${url}`);
    };
    await verifyPublic(output, fetchImpl);
    for (const url of bytes.keys()) assert.ok(calls.includes(url), `must verify ${url}`);
    internalStatus = 401;
    await assert.rejects(verifyPublic(output, fetchImpl), /Internal auth route is exposed/);
    bytes.set("https://herkules.dev/assets/fonts/team%20font.woff2", "corrupt");
    await assert.rejects(verifyPublic(output, fetchImpl), /Asset verification failed/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
