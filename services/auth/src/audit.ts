/**
 * Append-only audit. Owns the closed `AuditEvent` union, the single insert,
 * and the one Better Auth after-hook that turns plugin traffic into events.
 *
 * "Cannot be forgotten" is structural, not disciplinary:
 *  - Admin mutations exist only as `Audited` transactions (users.ts): the
 *    function that writes the change is the function that writes the row,
 *    in the same DB transaction.
 *  - Plugin-side events (login, consent, token, DCR) come from ONE after-hook
 *    keyed by path; adding a path without an extractor is a type error
 *    (`AUDITED_PATHS` is exhaustive over `PluginAuditPath`).
 *  - Gate rejections are written by `Gate.reject`, the only rejection path.
 *  - Every write is awaited. A failed audit insert fails the request
 *    (fail-closed audit); nothing goes through `runInBackground`.
 */
import type { AuthDb } from "./db/index.ts";
import type { AdmittedVia, GatePhase, GateReason } from "./gate.ts";

/** Who did it. Admin actions carry a user actor; boot jobs carry `system`. */
export type Actor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "system"; readonly job: string };

export type AuditEvent =
  | { readonly type: "login"; readonly userId: string; readonly via: AdmittedVia }
  | {
      readonly type: "gate.rejected";
      readonly githubLogin: string;
      readonly githubId: string;
      readonly userId?: string;
      readonly reason: GateReason;
      readonly phase: GatePhase;
    }
  | { readonly type: "gate.stale_allow"; readonly userId: string } // a grant kept a prior org verdict because GitHub was unreachable
  | {
      readonly type: "token.issued";
      readonly userId: string;
      readonly clientId: string;
      readonly grantType: "authorization_code" | "refresh_token";
      readonly audiences: readonly string[];
      readonly jti: string;
    }
  | {
      readonly type: "consent.granted";
      readonly userId: string;
      readonly clientId: string;
      readonly resources: readonly string[];
    }
  | { readonly type: "consent.denied"; readonly userId: string; readonly clientId: string }
  | {
      readonly type: "client.registered";
      readonly clientId: string;
      readonly name?: string;
      readonly redirectUris: readonly string[];
      readonly discovery: "dcr" | "cimd";
    }
  | {
      readonly type: "client.revoked";
      readonly actor: Actor;
      readonly userId: string;
      readonly clientId: string;
    }
  | { readonly type: "client.pruned"; readonly actor: Actor; readonly clientIds: readonly string[] }
  | {
      readonly type: "admin.role_set";
      readonly actor: Actor;
      readonly userId: string;
      readonly role: "admin" | "member";
      readonly previous: "admin" | "member";
    }
  | {
      readonly type: "admin.user_disabled";
      readonly actor: Actor;
      readonly userId: string;
      readonly reason?: string;
      readonly refreshTokensRevoked: number;
      readonly sessionsRevoked: number;
    }
  | { readonly type: "admin.user_enabled"; readonly actor: Actor; readonly userId: string }
  | {
      readonly type: "admin.sessions_revoked";
      readonly actor: Actor;
      readonly userId: string;
      readonly count: number;
    }
  | {
      readonly type: "admin.allowlist_added";
      readonly actor: Actor;
      readonly githubLogin: string;
      readonly note?: string;
    }
  | {
      readonly type: "admin.allowlist_removed";
      readonly actor: Actor;
      readonly githubLogin: string;
    }
  | { readonly type: "admin.seeded"; readonly userId: string; readonly githubLogin: string }; // env ADMIN_GITHUB_LOGINS promoted an existing member at boot

export type AuditType = AuditEvent["type"];

/** Stored row. `event` is the full AuditEvent as JSON; the indexed columns are projections for the admin list. */
export interface AuditRow {
  readonly id: string;
  readonly at: Date;
  readonly type: AuditType;
  readonly actorUserId: string | null;
  readonly subjectUserId: string | null;
  readonly clientId: string | null;
  readonly event: AuditEvent;
}

export interface AuditPage {
  readonly rows: readonly AuditRow[];
  /** Opaque keyset cursor (at,id); absent on the last page. */
  readonly next?: string;
}

export interface Audit {
  /** Insert one row. Uses `tx` when given so the row commits with the change it describes. */
  record(event: AuditEvent, tx?: AuthDb): Promise<void>;
  list(query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly type?: AuditType;
    readonly userId?: string;
  }): Promise<AuditPage>;
}

export function createAudit(db: AuthDb, now: () => Date): Audit {
  return {
    async record(event, tx) {
      await (tx ?? db).audit.insert({
        id: uuidv7(now()),
        at: now(),
        type: event.type,
        actorUserId: "actor" in event && event.actor.kind === "user" ? event.actor.userId : null,
        subjectUserId: "userId" in event && typeof event.userId === "string" ? event.userId : null,
        clientId: "clientId" in event ? event.clientId : null,
        event,
      });
    },
    async list(query) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const raw = await db.audit.page({
        type: query.type,
        userId: query.userId,
        after: decodeCursor(query.cursor),
        limit: limit + 1,
      });
      const rows = raw.slice(0, limit).map((r): AuditRow => ({
        id: r.id,
        at: r.at,
        type: r.type as AuditType,
        actorUserId: r.actorUserId,
        subjectUserId: r.subjectUserId,
        clientId: r.clientId,
        event: r.event as AuditEvent,
      }));
      const last = rows.at(-1);
      return raw.length > limit && last ? { rows, next: encodeCursor(last.at, last.id) } : { rows };
    },
  };
}

/** Time-ordered UUID (v7) so keyset paging on (at, id) is stable and insertion order is recoverable. */
export function uuidv7(at: Date): string {
  const ms = BigInt(at.getTime());
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

/**
 * A cursor a client sent that this service cannot parse. That is a client error,
 * not a server one: `app.ts` maps it to 400. Extends `TypeError` so the
 * `decodeCursor` contract (and its existing test) is unchanged.
 */
export class CursorError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime())) throw new CursorError("invalid cursor");
  return { at, id };
}

/** Better Auth paths that produce audit rows. Adding one here without an extractor fails to compile. */
export type PluginAuditPath =
  | "/callback/:id" // ctx.path is the ROUTE PATTERN for parameterised endpoints
  | "/oauth2/token"
  | "/oauth2/consent"
  | "/oauth2/register";

/**
 * Given the after-hook context, the event to record, or undefined when the
 * request did not complete (error responses are not audited here; the gate
 * audits its own rejections).
 */
type Extractor = (ctx: AfterHookContext) => AuditEvent | undefined;

/** The slice of Better Auth's hook context we read. Kept narrow so extractors are unit-testable with a literal. */
export interface AfterHookContext {
  readonly path: string;
  readonly body?: unknown;
  readonly context: {
    readonly newSession?: {
      readonly user: { readonly id: string; readonly admittedVia?: AdmittedVia | null };
    } | null;
    readonly session?: { readonly user: { readonly id: string } } | null;
    readonly returned?: unknown;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Payload of a JWT WE signed moments ago; no verification needed for an audit projection. */
export function decodeOwnJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export const AUDITED_PATHS: Readonly<Record<PluginAuditPath, Extractor>> = {
  // newSession set => a login completed (the gate already passed). via from the user row (mapProfileToUser wrote it).
  "/callback/:id": (ctx) => {
    const s = ctx.context.newSession;
    if (!s) return undefined;
    return { type: "login", userId: s.user.id, via: s.user.admittedVia ?? "org" };
  },
  // returned = token response; decode our own JWT payload WITHOUT verifying (we just signed it) for sub, client_id, aud, jti.
  // body.grant_type tells the grant. Opaque tokens (no resource) are impossible here: every registry client sends resource.
  "/oauth2/token": (ctx) => {
    const r = ctx.context.returned;
    if (!isRecord(r)) return undefined;
    const claims = decodeOwnJwtPayload(r.access_token);
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      typeof claims.client_id !== "string" ||
      typeof claims.jti !== "string"
    ) {
      return undefined;
    }
    const grant = isRecord(ctx.body) ? ctx.body.grant_type : undefined;
    const aud = claims.aud;
    return {
      type: "token.issued",
      userId: claims.sub,
      clientId: claims.client_id,
      grantType: grant === "refresh_token" ? "refresh_token" : "authorization_code",
      audiences:
        typeof aud === "string"
          ? [aud]
          : Array.isArray(aud)
            ? aud.filter((a): a is string => typeof a === "string")
            : [],
      jti: claims.jti,
    };
  },
  // body.accept + oauth_query (signed) -> client_id, resource[]; userId from ctx.context.session. Returned = { redirect: true, url }.
  "/oauth2/consent": (ctx) => {
    const r = ctx.context.returned;
    const userId = ctx.context.session?.user.id;
    if (
      !isRecord(r) ||
      typeof (r.url ?? r.redirect_uri) !== "string" ||
      !userId ||
      !isRecord(ctx.body)
    ) {
      return undefined;
    }
    const query = new URLSearchParams(
      typeof ctx.body.oauth_query === "string" ? ctx.body.oauth_query : "",
    );
    const clientId = query.get("client_id");
    if (!clientId) return undefined;
    return ctx.body.accept === true
      ? { type: "consent.granted", userId, clientId, resources: query.getAll("resource") }
      : { type: "consent.denied", userId, clientId };
  },
  // returned = the 201 client json: client_id, client_name, redirect_uris.
  "/oauth2/register": (ctx) => {
    const r = ctx.context.returned;
    if (!isRecord(r) || typeof r.client_id !== "string") return undefined;
    return {
      type: "client.registered",
      clientId: r.client_id,
      ...(typeof r.client_name === "string" ? { name: r.client_name } : {}),
      redirectUris: Array.isArray(r.redirect_uris)
        ? r.redirect_uris.filter((u): u is string => typeof u === "string")
        : [],
      discovery: "dcr",
    };
  },
};

/** The body of the one `hooks.after` middleware. Exhaustive over AUDITED_PATHS; other paths pass through untouched. */
export function auditAfterHook(audit: Audit): (ctx: AfterHookContext) => Promise<void> {
  return async (ctx) => {
    if (!Object.hasOwn(AUDITED_PATHS, ctx.path)) return;
    const event = AUDITED_PATHS[ctx.path as PluginAuditPath](ctx);
    if (event) await audit.record(event); // awaited: the audit row is part of the operation
  };
}
