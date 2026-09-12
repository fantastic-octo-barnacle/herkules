import { afterEach, expect, test } from "vite-plus/test";
import { request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGateway } from "../src/gateway.ts";
import type { Config } from "../src/config.ts";
// Node fetch ignores an overridden Host header; use HTTP directly to exercise routing.
function fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(url, init, (res) => {
      res.resume();
      resolve({ status: res.statusCode! });
    });
    req.on("error", reject);
    req.end();
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
    workers: [{ id: "gpu", model: "qwen", url: "http://worker", key: "worker-secret" }],
  } as Config;
  let hits = 0;
  const g = createGateway({
    config,
    membership: { ready, check: async () => member },
    identifyKey: async () => 2,
    fetch: async (input) => {
      hits++;
      return (typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).endsWith("/api/user/self")
        ? Response.json({ success: true, data: { id: 2 } })
        : Response.json({ data: [] });
    },
  });
  instances.push(g);
  for (const s of [g.public, g.internal]) {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
  }
  const url = (internal = false) =>
    `http://127.0.0.1:${((internal ? g.internal : g.public).address() as AddressInfo).port}`;
  return { g, url, hits: () => hits };
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
