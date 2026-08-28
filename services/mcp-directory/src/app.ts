/**
 * HTTP surface. One resource path; everything under it except /healthz is
 * behind `honoAuth`, which renders the RFC 9728 challenge (401 with
 * resource_metadata) that starts an IDE's OAuth discovery. The MCP handler is
 * the SDK's per-request entry: it serves the 2026-07-28 revision and, for
 * today's Claude Code / VS Code, the stateless 2025 path.
 */
import type { ResourceAuth } from "@herkules/auth-middleware";
import type { AuthEnv } from "@herkules/auth-middleware/hono";
import { honoAuth } from "@herkules/auth-middleware/hono";
import { principalOf, toAuthInfo } from "@herkules/auth-middleware/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { RESOURCE_NAME } from "./config.ts";
import type { DirectoryDeps } from "./tools.ts";
import { createDirectoryServer } from "./tools.ts";

export interface AppDeps extends DirectoryDeps {
  readonly auth: ResourceAuth;
  readonly onError?: (error: Error) => void;
}

export function createApp(deps: AppDeps) {
  const handler = createMcpHandler(
    (ctx) => {
      if (!ctx.authInfo) throw new Error("MCP request reached the handler without authInfo");
      return createDirectoryServer(principalOf(ctx.authInfo), deps);
    },
    { onerror: deps.onError },
  );

  const app = new Hono<AuthEnv>();
  const path = `/mcp/${RESOURCE_NAME}`;

  app.get(`${path}/healthz`, (c) => c.json({ ok: true }));
  app.on(["GET", "POST", "DELETE"], path, honoAuth(deps.auth), (c) =>
    handler.fetch(c.req.raw, { authInfo: toAuthInfo(c.var.principal) }),
  );

  return { app, close: () => handler.close() };
}
