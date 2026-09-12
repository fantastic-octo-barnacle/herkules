import { modelCatalog } from "../src/model-catalog.ts";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGateway } from "../src/gateway.ts";
import type { Config } from "../src/config.ts";
// Node fetch ignores an overridden Host header; use HTTP directly to exercise routing.
function fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, init, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
const instances: ReturnType<typeof createGateway>[] = [];
afterEach(() => {
  for (const g of instances)
    for (const s of [g.public, g.internal]) {
      s.closeAllConnections();
      s.close();
    }
  instances.length = 0;
});
async function fixture(ready = true, member = true) {
  const config = {
    AI_PORTAL_ORIGIN: "http://portal.test",
    AI_API_ORIGIN: "http://api.test",
    NEW_API_URL: "http://new-api",
    dispatchKey: "dispatch-secret",
    modelCatalog: { qwen: modelCatalog["qwen3.8-27b"] },
    workers: [{ id: "gpu", model: "qwen", url: "http://worker", key: "worker-secret" }],
  } as unknown as Config;
  let hits = 0;
  const forwarded: Record<string, unknown>[] = [];
  const identifyKey = vi.fn(async (hash: string) =>
    hash === createHash("sha256").update("test").digest("hex") ? 2 : undefined,
  );
  const g = createGateway({
    config,
    membership: { ready, check: async () => member },
    identifyKey,
    fetch: async (input, init) => {
      hits++;
      if (typeof init?.body === "string") forwarded.push(JSON.parse(init.body));
      return (typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).endsWith("/api/user/self")
        ? Response.json({ success: true, data: { id: 2 } })
        : Response.json({ data: [{ id: "qwen", object: "model" }] });
    },
  });
  instances.push(g);
  for (const s of [g.public, g.internal]) {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
  }
  const url = (internal = false) =>
    `http://127.0.0.1:${((internal ? g.internal : g.public).address() as AddressInfo).port}`;
  return { g, url, identifyKey, forwarded, hits: () => hits };
}
test("API hostname has no dashboard or alternate generation paths", async () => {
  const f = await fixture();
  for (const path of ["/api/user/self", "/v1/responses", "/pg/chat/completions", "/api/setup"]) {
    expect((await fetch(f.url() + path, { headers: { host: "api.test" } })).status).toBe(404);
  }
  expect(f.hits()).toBe(0);
});
test("public setup/password login and invalid internal tickets are rejected", async () => {
  const f = await fixture();
  for (const path of [
    "/api/setup",
    "/api/user/topup",
    "/api/user/aff",
    "/api/user/checkin",
    "/api/user/login",
    "/api/oauth/github",
    "/api/user/self/oauth/bindings/1",
  ]) {
    expect(
      (await fetch(f.url() + path, { method: "DELETE", headers: { host: "portal.test" } })).status,
    ).toBe(404);
  }
  expect(
    (
      await fetch(f.url(true) + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer dispatch-secret", "x-herkules-ticket": "forged" },
      })
    ).status,
  ).toBe(401);
  expect(f.hits()).toBe(0);
});
test("stale membership and disabled identities fail closed before inference", async () => {
  const stale = await fixture(false);
  expect((await fetch(stale.url() + "/v1/models", { headers: { host: "api.test" } })).status).toBe(
    503,
  );
  expect(stale.hits()).toBe(0);
  const disabled = await fixture(true, false);
  expect(
    (
      await fetch(disabled.url() + "/v1/models", {
        headers: { host: "api.test", authorization: "Bearer sk-test" },
      })
    ).status,
  ).toBe(403);
});

test("standard sk-prefixed keys match the stored unprefixed key hash", async () => {
  const f = await fixture();
  expect(
    (
      await fetch(f.url() + "/v1/models", {
        headers: { host: "api.test", authorization: "Bearer sk-test" },
      })
    ).status,
  ).toBe(200);
  expect(f.identifyKey).toHaveBeenCalledWith(createHash("sha256").update("test").digest("hex"));
  expect(
    (
      await fetch(f.url() + "/v1/models", {
        headers: { host: "api.test", authorization: "Bearer sk-unknown" },
      })
    ).status,
  ).toBe(401);
});

test("encoded paths cannot change routes after admission", async () => {
  const f = await fixture();
  for (const path of [
    "/api/user/login%3fignored",
    "/api/user/login%23ignored",
    "/api/x%2f..%2fsetup",
    "/api%2f%2fsetup",
    "/api/setup%0a",
  ]) {
    expect(
      (
        await fetch(f.url() + path, {
          method: "POST",
          headers: { host: "portal.test" },
        })
      ).status,
    ).toBe(400);
  }
  expect(f.hits()).toBe(0);
});

test("clients may request 64K output but cannot exceed the cap", async () => {
  const f = await fixture();
  for (const [max_tokens, status] of [
    [65_536, 200],
    [65_537, 400],
  ]) {
    expect(
      (
        await fetch(f.url() + "/v1/chat/completions", {
          method: "POST",
          headers: {
            host: "api.test",
            authorization: "Bearer sk-test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "qwen",
            messages: [{ role: "user", content: "hello" }],
            stream: true,
            max_tokens,
          }),
        })
      ).status,
    ).toBe(status);
  }
});

test("omitting an output limit reserves 32K for coding responses", async () => {
  const f = await fixture();
  expect(
    (
      await fetch(f.url() + "/v1/chat/completions", {
        method: "POST",
        headers: {
          host: "api.test",
          authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      })
    ).status,
  ).toBe(200);
  expect(f.forwarded).toEqual([
    expect.objectContaining({ max_tokens: 32_768, temperature: 1, top_p: 0.95 }),
  ]);
});

test("model details use the authorized list", async () => {
  const f = await fixture();
  const headers = { host: "api.test", authorization: "Bearer sk-test" };
  const listing = await fetch(f.url() + "/v1/models", { headers });
  expect(listing.status).toBe(200);
  expect(JSON.parse(listing.body).data[0]).toMatchObject({ id: "qwen", context_length: 131072 });
  const detail = await fetch(f.url() + "/v1/models/qwen", { headers });
  expect(detail.status).toBe(200);
  expect(JSON.parse(detail.body)).toMatchObject({ id: "qwen", object: "model" });
  expect((await fetch(f.url() + "/v1/models/qwen3.8-27b", { headers })).status).toBe(404);
  expect((await fetch(f.url() + "/v1/models/qwen", { headers: { host: "api.test" } })).status).toBe(
    401,
  );
});

test("explicit sampling choices override the model defaults", async () => {
  const f = await fixture();
  await fetch(f.url() + "/v1/chat/completions", {
    method: "POST",
    headers: {
      host: "api.test",
      authorization: "Bearer sk-test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "qwen", messages: [], stream: true, temperature: 0, top_p: 0.8 }),
  });
  expect(f.forwarded).toEqual([expect.objectContaining({ temperature: 0, top_p: 0.8 })]);
});
