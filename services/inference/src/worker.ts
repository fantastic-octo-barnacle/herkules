import { MAX_OUTPUT_TOKENS } from "./limits.ts";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { body, cancellation, failure, json, matches } from "./http.ts";
import { AdmissionError } from "./queue.ts";

interface ModelProfile {
  model: string;
  context: number;
  slots: number;
}
function parseProfiles(value: unknown): ModelProfile[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (p) =>
        !p ||
        typeof p.model !== "string" ||
        !p.model.length ||
        !Number.isInteger(p.context) ||
        p.context < 1024 ||
        !Number.isInteger(p.slots) ||
        p.slots < 1 ||
        p.slots > 16,
    )
  )
    throw new Error("Invalid worker model profiles");
  return value;
}
export interface WorkerOptions {
  llamaUrl: string;
  llamaKey: string;
  key: string;
  model: string;
  context: number;
  profiles?: ModelProfile[];
  fetch?: typeof fetch;
  heartbeatMs?: number;
}
export function createWorker(options: WorkerOptions) {
  const transport = options.fetch ?? fetch;
  const profiles = options.profiles ?? [
    { model: options.model, context: options.context, slots: 1 },
  ];
  if (new Set(profiles.map((p) => p.model)).size !== profiles.length)
    throw new Error("Duplicate model profiles");
  let activeModel: string | undefined;
  let active = 0;
  const reserved = new Set<number>();
  const llama = (path: string, init: RequestInit = {}) =>
    transport(options.llamaUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${options.llamaKey}` },
    });
  async function slots(model: string, signal?: AbortSignal) {
    const response = await llama(
      "/slots" + (options.profiles ? `?model=${encodeURIComponent(model)}` : ""),
      {
        signal: AbortSignal.any([
          AbortSignal.timeout(options.profiles ? 90_000 : 5000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok) throw new AdmissionError("slots_unavailable", 503);
    const slots: unknown = await response.json();
    if (!Array.isArray(slots)) throw new AdmissionError("slots_unavailable", 503);
    return slots as { id?: number; is_processing?: boolean }[];
  }
  let inspection: ReturnType<typeof slots> | undefined;
  function inspectSlots(model: string) {
    // The router returns 503 to concurrent autoload attempts. Share the load
    // and slot snapshot; reservations below still assign distinct slot IDs.
    inspection ??= (async () => {
      if (options.profiles) {
        const catalog = await llama("/models", { signal: AbortSignal.timeout(5000) });
        if (!catalog.ok) throw new AdmissionError("models_unavailable", 503);
        const data = (await catalog.json()) as {
          data?: { id: string; status?: { value?: string } }[];
        };
        if (!Array.isArray(data.data)) throw new AdmissionError("models_unavailable", 503);
        for (const other of data.data) {
          if (other.id === model || other.status?.value === "unloaded") continue;
          if (other.status?.value !== "loaded") throw new AdmissionError("worker_not_idle", 409);
          const response = await llama(
            `/slots?model=${encodeURIComponent(other.id)}&autoload=false`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!response.ok) throw new AdmissionError("slots_unavailable", 503);
          const existing: unknown = await response.json();
          if (!Array.isArray(existing) || existing.some((s) => s?.is_processing !== false))
            throw new AdmissionError("worker_not_idle", 409);
        }
      }
      return await slots(model);
    })().finally(() => {
      inspection = undefined;
    });
    return inspection;
  }
  return createServer(async (req, res) => {
    const cancel = cancellation(req, res);
    try {
      if (!matches(req.headers.authorization, `Bearer ${options.key}`)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && req.url === "/healthz") {
        const ready = options.profiles
          ? await llama("/health", { signal: AbortSignal.timeout(5000) })
              .then((r) => r.ok)
              .catch(() => false)
          : active === 0 &&
            (await slots(options.model)
              .then((s) => s.length === 1 && s[0]?.is_processing === false)
              .catch(() => false));
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
      const profile = profiles.find((p) => p.model === input.model);
      if (!profile || input.stream !== true) throw new AdmissionError("unsupported_request", 400);
      if (
        !Number.isInteger(input.max_tokens) ||
        Number(input.max_tokens) < 1 ||
        Number(input.max_tokens) > MAX_OUTPUT_TOKENS
      ) {
        throw new AdmissionError("invalid_output_limit", 400);
      }
      // llama.cpp accepts these aliases with precedence over max_tokens. Pin
      // all three to the budget used for the context check below.
      input.n_predict = input.max_tokens;
      input.max_completion_tokens = input.max_tokens;
      if ((activeModel && activeModel !== profile.model) || active >= profile.slots)
        throw new AdmissionError("worker_busy", 409);
      activeModel = profile.model;
      active++;
      let slotId: number | undefined;
      try {
        const actual = await inspectSlots(profile.model);
        if (actual.length !== profile.slots)
          throw new AdmissionError("slot_configuration_mismatch", 503);
        const index = actual.findIndex(
          (s, i) => s.is_processing === false && !reserved.has(s.id ?? i),
        );
        if (index < 0) throw new AdmissionError("worker_not_idle", 409);
        slotId = actual[index]!.id ?? index;
        reserved.add(slotId);
        input.id_slot = slotId;
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
            model: profile.model,
            content: templated.prompt,
            add_special: true,
            parse_special: true,
          }),
          signal: cancel.signal,
        });
        if (!tokens.ok) throw new AdmissionError("tokenizer_unavailable", 503);
        const counted = (await tokens.json()) as { tokens?: unknown[] };
        if (!Array.isArray(counted.tokens)) throw new AdmissionError("tokenizer_unavailable", 503);
        if (counted.tokens.length + Number(input.max_tokens) > profile.context)
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
        if (slotId !== undefined) reserved.delete(slotId);
        active--;
        if (!active) activeModel = undefined;
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
    profiles: process.env.WORKER_PROFILES_FILE
      ? parseProfiles(JSON.parse(await readFile(process.env.WORKER_PROFILES_FILE, "utf8")))
      : undefined,
  });
  server.listen(Number(process.env.PORT ?? 8081), "127.0.0.1", () =>
    console.log("AI worker adapter listening on loopback"),
  );
}
