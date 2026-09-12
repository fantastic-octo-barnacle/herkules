import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { body, cancellation, failure, json, matches } from "./http.ts";
import { AdmissionError } from "./queue.ts";

export interface WorkerOptions {
  llamaUrl: string;
  llamaKey: string;
  key: string;
  model: string;
  context: number;
  fetch?: typeof fetch;
  heartbeatMs?: number;
}
export function createWorker(options: WorkerOptions) {
  const transport = options.fetch ?? fetch;
  let busy = false;
  const llama = (path: string, init: RequestInit = {}) =>
    transport(options.llamaUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${options.llamaKey}` },
    });
  async function idle() {
    const response = await llama("/slots", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const slots: unknown = await response.json();
    return (
      Array.isArray(slots) && slots.length === 1 && slots.every((s) => s?.is_processing === false)
    );
  }
  return createServer(async (req, res) => {
    const cancel = cancellation(req, res);
    try {
      if (!matches(req.headers.authorization, `Bearer ${options.key}`)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && req.url === "/healthz") {
        const ready = !busy && (await idle().catch(() => false));
        json(res, ready ? 200 : 503, { ready });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        json(res, 404, { error: "not_found" });
        return;
      }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse((await body(req)).toString());
      } catch (error) {
        if (error instanceof AdmissionError) throw error;
        throw new AdmissionError("invalid_json", 400);
      }
      if (!input || typeof input !== "object") throw new AdmissionError("invalid_json", 400);
      if (
        !Array.isArray(input.messages) ||
        input.messages.some(
          (m) =>
            !m || typeof m !== "object" || (m.content !== null && typeof m.content !== "string"),
        )
      )
        throw new AdmissionError("text_messages_required", 400);
      if (input.model !== options.model || input.stream !== true)
        throw new AdmissionError("unsupported_request", 400);
      if (
        !Number.isInteger(input.max_tokens) ||
        Number(input.max_tokens) < 1 ||
        Number(input.max_tokens) > 8192
      ) {
        throw new AdmissionError("invalid_output_limit", 400);
      }
      if (busy) throw new AdmissionError("worker_busy", 409);
      busy = true;
      try {
        if (!(await idle())) throw new AdmissionError("worker_not_idle", 409);
        const template = await llama("/apply-template", {
          method: "POST",
          body: JSON.stringify({ ...input, add_generation_prompt: true }),
          signal: cancel.signal,
        });
        if (!template.ok) throw new AdmissionError("template_unavailable", 503);
        const templated = (await template.json()) as { prompt?: string };
        if (typeof templated.prompt !== "string")
          throw new AdmissionError("template_unavailable", 503);
        const tokens = await llama("/tokenize", {
          method: "POST",
          body: JSON.stringify({
            content: templated.prompt,
            add_special: true,
            parse_special: true,
          }),
          signal: cancel.signal,
        });
        if (!tokens.ok) throw new AdmissionError("tokenizer_unavailable", 503);
        const counted = (await tokens.json()) as { tokens?: unknown[] };
        if (!Array.isArray(counted.tokens)) throw new AdmissionError("tokenizer_unavailable", 503);
        if (counted.tokens.length + Number(input.max_tokens) > options.context)
          throw new AdmissionError("context_length_exceeded", 400);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": heartbeat\n\n");
        }, options.heartbeatMs ?? 10_000);
        try {
          const response = await llama("/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ ...input, stream_options: { include_usage: true } }),
            signal: cancel.signal,
          });
          if (!response.ok || !response.body) {
            res.write(
              `data: ${JSON.stringify({ error: { code: "worker_error", message: `Model server returned ${response.status}` } })}\n\n`,
            );
            res.end();
            return;
          }
          for await (const chunk of response.body) {
            if (cancel.signal.aborted) break;
            if (!res.write(chunk)) {
              // Keep memory bounded while allowing cancellation of a slow reader.
              while (res.writableLength > 64 * 1024 && !cancel.signal.aborted)
                await delay(10, undefined, { signal: cancel.signal });
            }
          }
          res.end();
        } finally {
          clearInterval(heartbeat);
        }
      } finally {
        busy = false;
      }
    } catch (error) {
      failure(res, error);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = async (name: string) => {
    const path = process.env[name];
    if (!path) throw new Error(`${name} is required`);
    const value = (await readFile(path, "utf8")).trim();
    if (value.length < 32) throw new Error(`${name} is invalid`);
    return value;
  };
  const server = createWorker({
    llamaUrl: process.env.LLAMA_URL ?? "http://127.0.0.1:8080",
    llamaKey: await secret("LLAMA_KEY_FILE"),
    key: await secret("WORKER_KEY_FILE"),
    model: process.env.WORKER_MODEL ?? "qwen3.8-27b",
    context: Number(process.env.WORKER_CONTEXT ?? 131072),
  });
  server.listen(Number(process.env.PORT ?? 8081), "127.0.0.1", () =>
    console.log("AI worker adapter listening on loopback"),
  );
}
