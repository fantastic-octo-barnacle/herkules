import { afterEach, expect, test } from "vite-plus/test";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorker } from "../src/worker.ts";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers.length = 0;
});
async function start(transport: typeof fetch) {
  const s = createWorker({
    llamaUrl: "http://llama",
    llamaKey: "private",
    key: "worker",
    model: "qwen",
    context: 128,
    heartbeatMs: 10,
    fetch: transport,
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const request = {
  method: "POST",
  headers: { authorization: "Bearer worker", "content-type": "application/json" },
  body: JSON.stringify({
    model: "qwen",
    stream: true,
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
  }),
};
test("fresh slot checks reject existing computation after adapter restart", async () => {
  const url = await start(async () => Response.json([{ is_processing: true }]));
  expect((await fetch(url + "/v1/chat/completions", request)).status).toBe(409);
  expect((await fetch(url + "/healthz")).status).toBe(401);
});
test("tokenized prompt plus output must fit before generation starts", async () => {
  let generated = false;
  const url = await start(async (input) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/slots") return Response.json([{ is_processing: false }]);
    if (path === "/apply-template") return Response.json({ prompt: "template" });
    if (path === "/tokenize") return Response.json({ tokens: Array(100).fill(1) });
    generated = true;
    return new Response();
  });
  expect((await fetch(url + "/v1/chat/completions", request)).status).toBe(400);
  expect(generated).toBe(false);
});
test("prefill emits heartbeats, rejects overlap and cancels on disconnect", async () => {
  let upstream: AbortSignal | null | undefined;
  const url = await start(async (input, init) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/slots") return Response.json([{ is_processing: false }]);
    if (path === "/apply-template") return Response.json({ prompt: "template" });
    if (path === "/tokenize") return Response.json({ tokens: [1] });
    upstream = init?.signal;
    await new Promise((_, reject) =>
      upstream?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
    return new Response();
  });
  const c = new AbortController();
  const response = await fetch(url + "/v1/chat/completions", { ...request, signal: c.signal });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": heartbeat");
  expect((await fetch(url + "/v1/chat/completions", request)).status).toBe(409);
  c.abort();
  await expect.poll(() => upstream?.aborted).toBe(true);
});
