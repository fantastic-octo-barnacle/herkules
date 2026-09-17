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
  assert.equal(m.calls.filter((c) => c.method === "POST").length, routes.length);
  const firstWorker = routes.findIndex((r) => r.script);
  assert.equal(firstWorker, 11);
  assert.ok(routes.slice(firstWorker).every((r) => r.script));
});

test("detaches only owned asset routes and preserves existing bypasses and unrelated routes", async () => {
  const unrelated = { id: "other", pattern: "status.herkules.dev/*", script: "monitor" };
  const m = mock([...routes.map((r, i) => ({ ...r, id: `${i}` })), unrelated]);
  await detach(m.api);
  assert.deepEqual(m.records(), [
    ...routes.map((r, i) => ({ ...r, id: `${i}` })).filter((r) => !r.script),
    unrelated,
  ]);
});

test("conflicting application routes stop before mutation", async () => {
  for (const { pattern } of routes) {
    const m = mock([{ id: "foreign", pattern, script: "someone-else" }]);
    await assert.rejects(detach(m.api), /Conflicting/);
    await assert.rejects(attach(m.api), /Conflicting/);
    assert.ok(
      m.calls.every((c) => c.method === "GET"),
      pattern,
    );
  }
});

test("legacy-only deployments detach without requiring new routes", async () => {
  const m = mock([
    { id: "platform", pattern: "herkules.dev/*", script: "herkules-platform" },
    { id: "legacy", pattern: "bbs.herkules.dev/assets/*", script: "herkules-bbs-assets" },
  ]);
  await detach(m.api);
  assert.deepEqual(m.records(), []);
});

test("BBS wildcard specificity preserves broad origin prefixes and frontend delivery", () => {
  // These managed patterns only have a trailing wildcard; Cloudflare selects
  // the most specific matching route, including a no-Worker exclusion.
  const destination = (path) =>
    routes
      .filter((r) => `bbs.herkules.dev${path}`.startsWith(r.pattern.slice(0, -1)))
      .sort((a, b) => b.pattern.length - a.pattern.length)[0]?.script ?? "origin";
  for (const prefix of ["api", "login", "callback", "logout", "healthz", "mcp", "articles", "kb"]) {
    for (const suffix of ["", "?q=edge", "/child", "-lookalike"]) {
      assert.equal(destination(`/${prefix}${suffix}`), "origin", `${prefix}${suffix}`);
    }
  }
  for (const path of ["/", "/search?q=edge", "/assets/main.js", "/favicon.svg", "/settings"]) {
    assert.equal(destination(path), "herkules-bbs-assets", path);
  }
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

test("failed BBS bypass, legacy route or catchall activation restores origin delivery", async () => {
  for (const pattern of [
    "bbs.herkules.dev/kb*",
    "bbs.herkules.dev/assets/*",
    "bbs.herkules.dev/*",
  ]) {
    const m = mock([], (method, body) => method === "POST" && body?.pattern === pattern);
    assert.equal(
      await activate({ api: m.api, upload: async () => {}, verify: async () => assert.fail() }),
      "origin",
    );
    assert.ok(m.records().every((r) => !r.script));
    if (pattern === "bbs.herkules.dev/kb*") {
      assert.ok(
        m.calls.every((c) => !c.body?.script),
        "no Worker activates before all bypasses",
      );
    }
  }
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
      verify: async () => assert.equal(m.records().length, routes.length),
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
    await writeFile(join(output, "bbs-assets/index.html"), "<html>bbs</html>");
    bytes.set("https://bbs.herkules.dev/", "<html>bbs</html>");
    bytes.set("https://bbs.herkules.dev/search?q=edge", "<html>bbs</html>");
    const overrides = new Map();
    let internalStatus = 404;
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (overrides.has(url)) return overrides.get(url)();
      if (bytes.has(url))
        return new Response(bytes.get(url), {
          headers: {
            "x-herkules-delivery": "cloudflare-assets-experiment",
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          },
        });
      if (url === "https://bbs.herkules.dev/api/viewer") return Response.json({ viewer: null });
      if (url === "https://bbs.herkules.dev/healthz") return Response.json({ ok: true });
      if (url === "https://bbs.herkules.dev/articles/release-check-invalid")
        return new Response("<html>missing article</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
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
    for (const path of ["/api/viewer", "/healthz", "/articles/release-check-invalid"]) {
      assert.ok(calls.includes(`https://bbs.herkules.dev${path}`));
    }
    for (const path of ["/", "/search?q=edge"]) {
      const url = `https://bbs.herkules.dev${path}`;
      for (const headers of [
        {},
        { "x-herkules-delivery": "cloudflare-assets-experiment" },
        {
          "x-herkules-delivery": "cloudflare-assets-experiment",
          "content-type": "text/html",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      ]) {
        overrides.set(url, () => new Response("<html>bbs</html>", { headers }));
        await assert.rejects(verifyPublic(output, fetchImpl), /BBS document/);
      }
      overrides.delete(url);
      bytes.set(url, "stale shell");
      await assert.rejects(verifyPublic(output, fetchImpl), /BBS document/);
      bytes.set(url, "<html>bbs</html>");
    }
    for (const [path, body, status] of [
      ["/api/viewer", { viewer: null }, 200],
      ["/healthz", { ok: true }, 200],
      ["/articles/release-check-invalid", null, 404],
    ]) {
      const url = `https://bbs.herkules.dev${path}`;
      overrides.set(url, () =>
        Response.json(body, {
          status,
          headers: { "x-herkules-delivery": "cloudflare-assets-experiment" },
        }),
      );
      await assert.rejects(verifyPublic(output, fetchImpl), /BBS .*bypass failed/);
      overrides.set(
        url,
        () =>
          new Response("<html>SPA instead of origin</html>", {
            headers: { "content-type": "text/html" },
          }),
      );
      await assert.rejects(verifyPublic(output, fetchImpl), /BBS .*bypass failed/);
      overrides.delete(url);
    }
    overrides.set("https://bbs.herkules.dev/api/viewer", () =>
      Response.json({ viewer: { id: "unexpected" } }),
    );
    await assert.rejects(verifyPublic(output, fetchImpl), /BBS bypass failed/);
    overrides.clear();
    overrides.set("https://bbs.herkules.dev/healthz", () => Response.json({ ok: false }));
    await assert.rejects(verifyPublic(output, fetchImpl), /BBS bypass failed/);
    overrides.clear();
    internalStatus = 401;
    await assert.rejects(verifyPublic(output, fetchImpl), /Internal auth route is exposed/);
    bytes.set("https://herkules.dev/assets/fonts/team%20font.woff2", "corrupt");
    await assert.rejects(verifyPublic(output, fetchImpl), /Asset verification failed/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
