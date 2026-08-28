/**
 * @herkules/auth-middleware — public core.
 *
 * Verify a herkules access token on a resource server and answer with the
 * correct OAuth challenge. The TypeScript convenience over docs/tokens.md,
 * never a superset of it.
 *
 * Module map (packages/auth-middleware/src):
 *   index.ts      this file: mcpResource / apiResource and the ResourceAuth they return. Public surface.
 *   resource.ts   URL validation; JWKS and protected-resource-metadata URL derivation. Pure.
 *   verify.ts     header parsing, per-instance JWKS, jose policy, error classification. Only network user.
 *   principal.ts  Principal type; claims -> Principal boundary. Pure.
 *   failure.ts    the closed AuthFailure union. No HTTP.
 *   challenge.ts  AuthFailure -> Response; the only writer of WWW-Authenticate. Pure.
 *   hono.ts       subpath ./hono: honoAuth middleware + AuthEnv. Optional peer: hono.
 *   mcp.ts        subpath ./mcp: Principal <-> MCP SDK AuthInfo (structural type, no SDK import).
 *   testing.ts    subpath ./testing: createTestIssuer, the executable form of docs/tokens.md.
 * Call chain a reader traces: index -> verify -> { principal, challenge }. Two hops.
 */
import type { BodyStyle, ChallengeContext } from "./challenge.ts";
import { renderFailure } from "./challenge.ts";
import type { AuthFailure } from "./failure.ts";
import type { Principal, Role } from "./principal.ts";
import { roleSatisfies } from "./principal.ts";
import { jwksUrlFor, resourceMetadataUrlFor, validateResource } from "./resource.ts";
import { createTokenVerifier, parseAuthorization } from "./verify.ts";

/** docs/tokens.md §8: SHOULD tolerate up to 60 s. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export type { AuthFailure, InvalidTokenReason } from "./failure.ts";
export type { Principal, Role } from "./principal.ts";
export { roleSatisfies } from "./principal.ts";
export { resourceMetadataUrlFor } from "./resource.ts";
export type { BodyStyle };

/**
 * @typeParam S the resource's declared scope vocabulary. Defaults to `never`:
 * with no scopes declared, `Requirement.scopes` accepts only `[]` and
 * `deny.scope` cannot be called, so v1 cannot emit a scope challenge by accident.
 */
export interface ResourceAuthOptions<S extends string = never> {
  /** This server's canonical resource URL and the exact string expected in `aud`, e.g. https://herkules.dev/mcp/directory */
  readonly resource: string;
  /** Authorization-server issuer exactly as in `iss`, e.g. https://herkules.dev/auth (dev: http://localhost:3000/auth). */
  readonly issuer: string;
  /** Scope vocabulary this resource understands. Omit in v1. */
  readonly scopes?: readonly S[];
  /** Default `${issuer}/jwks`. */
  readonly jwksUrl?: string;
  /** Default: RFC 9728 derivation from `resource`. Override only when the PRM document lives on another origin. */
  readonly resourceMetadataUrl?: string;
  /** Default 60. TypeError above 300. */
  readonly clockToleranceSeconds?: number;
  /** JWKS transport seam. Default globalThis.fetch; tests pass `createTestIssuer().fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Authority the caller demands, declared at the call site. `role` and
 * `scopes` have different names and value types, and the caller never builds
 * the response, so "bare 403 vs insufficient_scope 403" cannot be got backwards.
 */
export interface Requirement<S extends string = never> {
  /** Minimum role; `admin` satisfies `member`. Failure -> 403 with NO challenge. */
  readonly role?: Role;
  /** All must be present. Failure -> 403 WITH insufficient_scope naming every missing scope at once. */
  readonly scopes?: readonly S[];
}

/**
 * The failure branch carries both what you log (`failure`) and what you return
 * (`response`), so a caller never re-derives a status code.
 */
export type AuthOutcome =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly failure: AuthFailure; readonly response: Response };

/**
 * A configured resource server. Construct once at boot (it owns this
 * resource's JWKS cache); reuse for every request.
 */
export interface ResourceAuth<S extends string = never> {
  readonly resource: string;
  readonly issuer: string;
  readonly resourceMetadataUrl: string;

  /**
   * Authenticate one request and, optionally, check what it may do. Reads only
   * the Authorization header today; takes the whole Request so DPoP (method +
   * URL) is a change inside this function, not a signature change. Never
   * throws for anything a client did; does not consume the body.
   */
  authenticate(request: Request, require?: Requirement<S>): Promise<AuthOutcome>;

  /** Same as `authenticate` for a raw token (websocket handshake, queue consumer, tests). */
  verifyToken(token: string, require?: Requirement<S>): Promise<AuthOutcome>;

  /**
   * Denials for checks that depend on data the handler had to fetch first
   * (ownership, per-record ACLs) and so cannot be a `Requirement` on the route.
   */
  readonly deny: {
    /** A denial re-authorizing cannot fix. 403, no WWW-Authenticate. `reason` is prose shown to the client. */
    permission(reason: string): Response;
    /** Valid token, too narrow. 403 with an insufficient_scope challenge. Uncallable while `S` is `never`. */
    scope(first: S, ...rest: readonly S[]): Response;
    /**
     * The verdict cannot be reached right now (the issuer, its JWKS or a token endpoint is down).
     * 503 + Retry-After, no challenge — never a 401, which would send every client back through
     * consent during an outage. Same wire format as the verifier's own `jwks_unavailable`.
     */
    unavailable(cause?: unknown): Response;
  };
}

/**
 * Declare an MCP resource server: MCP canonical-URL rules for `resource`
 * (https, or http on loopback; no credentials/query/fragment) and JSON-RPC
 * error bodies. Use for anything mounted at /mcp/<name>.
 * @throws TypeError at boot if `resource` or `issuer` is unusable.
 */
export function mcpResource<const S extends string = never>(
  options: ResourceAuthOptions<S>,
): ResourceAuth<S> {
  return createResourceAuth(options, "mcp", "json-rpc");
}

/**
 * Declare a plain HTTP API resource server: relaxed URL rules and
 * `{ error, error_description }` bodies.
 */
export function apiResource<const S extends string = never>(
  options: ResourceAuthOptions<S>,
): ResourceAuth<S> {
  return createResourceAuth(options, "api", "json");
}

function createResourceAuth<S extends string>(
  options: ResourceAuthOptions<S>,
  rules: "mcp" | "api",
  bodyStyle: BodyStyle,
): ResourceAuth<S> {
  const resource = validateResource(options.resource, rules);
  const issuer = options.issuer;
  const ctx: ChallengeContext = {
    resourceMetadataUrl: options.resourceMetadataUrl ?? resourceMetadataUrlFor(resource),
    bodyStyle,
  };
  const verifier = createTokenVerifier({
    issuer,
    resource,
    jwksUrl: options.jwksUrl ?? jwksUrlFor(issuer),
    clockToleranceSeconds: options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  });

  const fail = (failure: AuthFailure): AuthOutcome => ({
    ok: false,
    failure,
    response: renderFailure(failure, ctx),
  });

  const check = (
    principal: Principal,
    require: Requirement<S> | undefined,
  ): AuthFailure | undefined => {
    if (require?.role && !roleSatisfies(principal.role, require.role)) {
      return { kind: "forbidden", reason: `requires role ${require.role}` };
    }
    const missing = (require?.scopes ?? []).filter((s) => !principal.scopes.has(s));
    return missing.length > 0
      ? { kind: "insufficient_scope", missing: missing as [S, ...S[]] }
      : undefined;
  };

  const verifyToken = async (token: string, require?: Requirement<S>): Promise<AuthOutcome> => {
    const result = await verifier.verify(token);
    if (!result.ok) return fail(result.failure);
    const denied = check(result.principal, require);
    return denied ? fail(denied) : { ok: true, principal: result.principal };
  };

  return {
    resource,
    issuer,
    resourceMetadataUrl: ctx.resourceMetadataUrl,
    authenticate: (request, require) => {
      const parsed = parseAuthorization(request.headers.get("authorization"));
      return "failure" in parsed
        ? Promise.resolve(fail(parsed.failure))
        : verifyToken(parsed.token, require);
    },
    verifyToken,
    deny: {
      permission: (reason) => renderFailure({ kind: "forbidden", reason }, ctx),
      scope: (first, ...rest) =>
        renderFailure({ kind: "insufficient_scope", missing: [first, ...rest] }, ctx),
      unavailable: (cause) => renderFailure({ kind: "jwks_unavailable", cause }, ctx),
    },
  };
}
