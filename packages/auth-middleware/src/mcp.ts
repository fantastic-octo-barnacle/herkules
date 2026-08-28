/**
 * Subpath `@herkules/auth-middleware/mcp`. No SDK import: `McpAuthInfo` is a
 * structural twin of @modelcontextprotocol/server's AuthInfo
 * (packages/core-internal/src/types/types.ts, SDK 2.0.0), so a plain
 * fetch or Hono consumer never pulls the MCP SDK into its install graph.
 */
import type { Principal } from "./principal.ts";

export interface McpAuthInfo {
  readonly token: string;
  readonly clientId: string;
  readonly scopes: string[];
  /** Seconds since epoch. */
  readonly expiresAt?: number;
  /** RFC 8707 resource this token is valid for; must equal the MCP server's resource. */
  readonly resource?: URL;
  readonly extra?: Record<string, unknown>;
}

/** The key under `extra` that carries the whole principal. */
export const EXTRA_KEY = "herkules";

/**
 * Principal -> AuthInfo, for `transport.handleRequest(request, { authInfo })`.
 * The whole principal rides in `extra.herkules` (one source of truth; no
 * field-by-field re-derivation in tool handlers). Total function.
 */
export function toAuthInfo(principal: Principal): McpAuthInfo {
  return {
    token: principal.token,
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    expiresAt: Math.floor(principal.expiresAt.getTime() / 1000),
    resource: new URL(principal.resource),
    extra: { [EXTRA_KEY]: principal },
  };
}

/**
 * `extra.authInfo` (as delivered to a tool handler) -> Principal. Throws a
 * plain Error when `extra.herkules` is absent: that is a programmer error (the
 * transport was not given `toAuthInfo` output), not a client fault.
 */
export function principalOf(authInfo: unknown): Principal {
  const extra = isRecord(authInfo) ? authInfo.extra : undefined;
  const principal = isRecord(extra) ? extra[EXTRA_KEY] : undefined;
  if (
    !isRecord(principal) ||
    typeof principal.subject !== "string" ||
    typeof principal.token !== "string"
  ) {
    throw new Error(
      "authInfo carries no herkules principal: pass toAuthInfo(principal) to transport.handleRequest",
    );
  }
  return principal as unknown as Principal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
