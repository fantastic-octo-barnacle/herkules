import { serve } from "@hono/node-server";
import { mcpResource } from "@herkules/auth-middleware";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createUserInfo } from "@herkules/auth-middleware/userinfo";

export interface ServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** JWKS and user-info transport; tests route it in-process to the auth app. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createService(deps: ServiceDeps = {}) {
  const config = loadConfig(deps.env);
  const auth = mcpResource({
    resource: config.resource,
    issuer: config.issuer,
    jwksUrl: `${config.authInternal}/auth/jwks`,
    fetch: deps.fetch,
  });
  const userInfo = createUserInfo({ baseUrl: config.authInternal, fetch: deps.fetch });
  const { app, close } = createApp({
    auth,
    userInfo,
    onError: (err) => console.error("[mcp-directory]", err),
  });
  return { app, config, auth, userInfo, close };
}

export function main(): void {
  const service = createService();
  const server = serve({ fetch: service.app.fetch, port: service.config.port }, (info) => {
    console.log(`mcp-directory listening on :${info.port} for ${service.config.resource}`);
  });
  const shutdown = () => {
    server.close();
    void service.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && /[/\\]main\.(ts|mjs|js)$/.test(process.argv[1])) main();
