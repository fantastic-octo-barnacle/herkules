/**
 * Subpath `@herkules/auth-middleware/hono`. Optional peer: hono.
 * ~15 lines a consumer could inline; exists to give a typed `c.var.principal`.
 */
import type { MiddlewareHandler } from "hono";
import type { Principal } from "./principal.ts";
import type { Requirement, ResourceAuth } from "./index.ts";

/** Use as `new Hono<AuthEnv>()` so `c.var.principal` / `c.get("principal")` is typed. */
export type AuthEnv = { Variables: { principal: Principal } };

/**
 * On failure returns `outcome.response` (the 401/403/503 the verifier rendered).
 * On success sets `principal` and awaits `next()`. Nothing else: a handler
 * that discovers a denial later returns `auth.deny.permission(...)` itself.
 */
export function honoAuth<S extends string>(
  auth: ResourceAuth<S>,
  require?: Requirement<S>,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const outcome = await auth.authenticate(c.req.raw, require);
    if (!outcome.ok) return outcome.response;
    c.set("principal", outcome.principal);
    await next();
  };
}
