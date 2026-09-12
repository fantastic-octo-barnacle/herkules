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

test("router reserves distinct slots, blocks another model, and checks model context", async () => {
  const upstream: AbortSignal[] = [];
  const selected: number[] = [];
  let loading = false;
  const s = createWorker({
    llamaUrl: "http://llama",
    llamaKey: "private",
    key: "worker",
    model: "qwen",
    context: 128,
    profiles: [
      { model: "qwen", context: 128, slots: 2 },
      { model: "other", context: 64, slots: 1 },
    ],
    heartbeatMs: 10,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/models") return Response.json({ data: [] });
      if (url.pathname === "/slots") {
        expect(url.searchParams.get("model")).toBe("qwen");
        if (loading) return new Response(null, { status: 503 });
        loading = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        loading = false;
        return Response.json([
          { id: 0, is_processing: false },
          { id: 1, is_processing: false },
        ]);
      }
      if (url.pathname === "/apply-template") return Response.json({ prompt: "template" });
      if (url.pathname === "/tokenize") {
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}").model).toBe("qwen");
        return Response.json({ tokens: [1] });
      }
      selected.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}").id_slot);
      upstream.push(init!.signal!);
      await new Promise((_, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
      return new Response();
    },
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/chat/completions`;
  const c = new AbortController();
  try {
    await Promise.all([
      fetch(url, { ...request, signal: c.signal }),
      fetch(url, { ...request, signal: c.signal }),
    ]);
    await expect.poll(() => selected.length).toBe(2);
    expect(new Set(selected).size).toBe(2);
    expect((await fetch(url, request)).status).toBe(409);
    expect(
      (
        await fetch(url, {
          ...request,
          body: JSON.stringify({ ...JSON.parse(request.body), model: "other" }),
        })
      ).status,
    ).toBe(409);
  } finally {
    c.abort();
  }
  await expect.poll(() => upstream.every((signal) => signal.aborted)).toBe(true);
});

test("adapter restart cannot swap out another model with active slots", async () => {
  let loaded = false;
  const s = createWorker({
    llamaUrl: "http://llama",
    llamaKey: "private",
    key: "worker",
    model: "qwen",
    context: 128,
    profiles: [{ model: "qwen", context: 128, slots: 1 }],
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/models")
        return Response.json({ data: [{ id: "other", status: { value: "loaded" } }] });
      if (url.searchParams.get("model") === "other") {
        expect(url.searchParams.get("autoload")).toBe("false");
        return Response.json([{ id: 0, is_processing: true }]);
      }
      loaded = true;
      return Response.json([]);
    },
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const response = await fetch(
    `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/chat/completions`,
    request,
  );
  expect(response.status).toBe(409);
  expect(loaded).toBe(false);
});

test("cancelled cold load releases admission without reusing another model's slot snapshot", async () => {
  let releaseLoad!: () => void;
  let enteredLoad!: () => void;
  let closed!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredLoad = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const inspected: string[] = [];
  const s = createWorker({
    llamaUrl: "http://llama",
    llamaKey: "private",
    key: "worker",
    model: "qwen",
    context: 128,
    profiles: [
      { model: "qwen", context: 128, slots: 1 },
      { model: "other", context: 128, slots: 2 },
    ],
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/models") return Response.json({ data: [] });
      if (url.pathname === "/slots") {
        const model = url.searchParams.get("model")!;
        inspected.push(model);
        if (model === "qwen") {
          enteredLoad();
          await loading;
        }
        return Response.json(
          Array.from({ length: model === "qwen" ? 1 : 2 }, (_, id) => ({
            id,
            is_processing: false,
          })),
        );
      }
      if (url.pathname === "/apply-template") {
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}").model).toBe("other");
        return Response.json({ prompt: "template" });
      }
      if (url.pathname === "/tokenize") return Response.json({ tokens: [1] });
      return new Response("data: [DONE]\n\n");
    },
  });
  servers.push(s);
  s.once("request", (_req, res) => res.once("close", closed));
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/chat/completions`;
  const c = new AbortController();
  const first = fetch(url, { ...request, signal: c.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await entered;
  c.abort();
  await rejected;
  await disconnected;
  const timer = setTimeout(releaseLoad, 50);
  try {
    const second = await fetch(url, {
      ...request,
      body: JSON.stringify({ ...JSON.parse(request.body), model: "other" }),
    });
    expect(second.status).toBe(200);
    await second.text();
    expect(inspected).toEqual(["qwen", "other"]);
  } finally {
    clearTimeout(timer);
    releaseLoad();
  }
});
