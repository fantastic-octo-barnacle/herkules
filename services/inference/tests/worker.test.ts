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
async function start(transport: typeof fetch, context = 128) {
  const s = createWorker({
    llamaUrl: "http://llama",
    llamaKey: "private",
    key: "worker",
    model: "qwen",
    context,
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

test("the worker pins every output-limit alias to the admitted budget", async () => {
  let generated: Record<string, unknown> | undefined;
  const url = await start(async (input, init) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/slots") return Response.json([{ is_processing: false }]);
    if (path === "/apply-template") return Response.json({ prompt: "template" });
    if (path === "/tokenize") return Response.json({ tokens: [1] });
    if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
    generated = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n");
  });
  const response = await fetch(url + "/v1/chat/completions", {
    ...request,
    body: JSON.stringify({
      ...JSON.parse(request.body),
      n_predict: -1,
      max_completion_tokens: 999999,
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(generated).toMatchObject({ max_tokens: 32, n_predict: 32, max_completion_tokens: 32 });
});

test("64K output is accepted only when prompt plus output fits 128K", async () => {
  let promptTokens = 65_536;
  let generations = 0;
  const url = await start(async (input) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/slots") return Response.json([{ is_processing: false }]);
    if (path === "/apply-template") return Response.json({ prompt: "template" });
    if (path === "/tokenize") return Response.json({ tokens: Array(promptTokens).fill(1) });
    generations++;
    return new Response("data: [DONE]\n\n");
  }, 131_072);
  const run = (max_tokens: number) =>
    fetch(url + "/v1/chat/completions", {
      ...request,
      body: JSON.stringify({ ...JSON.parse(request.body), max_tokens }),
    });
  const accepted = await run(65_536);
  expect(accepted.status).toBe(200);
  await accepted.text();
  expect((await run(65_537)).status).toBe(400);
  promptTokens++;
  expect((await run(65_536)).status).toBe(400);
  expect(generations).toBe(1);
});
