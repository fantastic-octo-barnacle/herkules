import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";

/** Route a fetch to an in-process Hono app (any origin). */
export function fetchVia(app: { request: Hono["request"] }): typeof globalThis.fetch {
  return async (input, init) => app.request(input instanceof Request ? input : String(input), init);
}

/** An SDK 2.0 client connected to the directory over an in-process fetch with a Bearer token. */
export async function connect(
  url: string,
  token: string | undefined,
  fetch: typeof globalThis.fetch,
) {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch,
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** A 2025-era JSON-RPC POST with no envelope: what Claude Code and VS Code send today. */
export async function legacyCall(
  url: string,
  token: string | undefined,
  fetch: typeof globalThis.fetch,
  method: string,
  params: unknown = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** Parse a JSON or single-event SSE MCP response body. */
export async function rpcResult(res: Response): Promise<unknown> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    return data ? JSON.parse(data) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}
