import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { AdmissionError } from "./queue.ts";
export function matches(value: string | undefined, expected: string) {
  return (
    !!value &&
    Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export async function body(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new AdmissionError("request_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function cancellation(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}
export async function relay(response: Response, res: ServerResponse, signal: AbortSignal) {
  const headers: Record<string, string | string[]> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "location",
    "www-authenticate",
    "retry-after",
    "auth-version",
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  headers["cache-control"] = "no-store";
  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body) {
      if (signal.aborted) break;
      if (!res.write(chunk)) await once(res, "drain", { signal });
    }
  }
  res.end();
}
export function failure(res: ServerResponse, error: unknown) {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const known = error instanceof AdmissionError;
  json(res, known ? error.status : 503, {
    error: {
      type: "service_error",
      code: known ? error.code : "service_unavailable",
      message: known ? error.message : "AI service temporarily unavailable",
    },
  });
}
