/**
 * @herkules/auth-middleware/userinfo — a client for the auth service's
 * user-info API (`GET /auth/api/users/:id`, `/users`, `/me`), called with the
 * CALLER'S OWN token. A resource server never holds a credential of its own for
 * user data: any registry audience is accepted by the auth service, so the
 * bearer that reached this server is forwarded unchanged, and a banned user's
 * token is refused upstream.
 *
 * Every method returns a value or throws `UserInfoError`; response shapes are
 * checked by hand (this package deliberately has no schema dependency).
 */

/** A type alias (not an interface) so it stays assignable to `Record<string, unknown>` for MCP structured content. */
export type Member = {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly githubId: string;
};

/** How the issuer sees the presented token (`/auth/api/me`). Role comes from the user row, so a demotion shows immediately. */
export type Caller =
  | { readonly kind: "session"; readonly userId: string; readonly role: "admin" | "member" }
  | {
      readonly kind: "token";
      readonly userId: string;
      readonly role: "admin" | "member";
      readonly clientId: string;
      readonly audiences: readonly string[];
      readonly jti: string;
    };

export class UserInfoError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UserInfoError";
    this.status = status;
    this.code = code;
  }
}

export interface UserInfo {
  /** GET /auth/api/users/:id. `undefined` when the auth service has no such user. */
  member(token: string, id: string): Promise<Member | undefined>;
  /** GET /auth/api/users: every non-disabled member. */
  members(token: string): Promise<readonly Member[]>;
  /** GET /auth/api/me. */
  me(token: string): Promise<Caller>;
}

export interface UserInfoOptions {
  /** e.g. http://auth:3001 — the auth service's routes are mounted under /auth. */
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createUserInfo(options: UserInfoOptions): UserInfo {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const base = `${options.baseUrl.replace(/\/$/, "")}/auth/api`;

  async function call(token: string, path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UserInfoError(503, "unavailable", `user-info API unreachable: ${String(err)}`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (res.ok || res.status === 404) return { status: res.status, body };
    const err = isRecord(body) ? body : {};
    throw new UserInfoError(
      res.status,
      typeof err.error === "string" ? err.error : "upstream_error",
      typeof err.error_description === "string"
        ? err.error_description
        : `user-info API answered ${res.status}`,
    );
  }

  return {
    async member(token, id) {
      const { status, body } = await call(token, `/users/${encodeURIComponent(id)}`);
      return status === 404 ? undefined : parseMember(body);
    },
    async members(token) {
      const { body: b } = await call(token, "/users");
      if (!isRecord(b) || !Array.isArray(b.users)) throw malformed("/users");
      return b.users.map(parseMember);
    },
    async me(token) {
      const { body: b } = await call(token, "/me");
      return parseCaller(b);
    },
  };
}

function malformed(path: string): UserInfoError {
  return new UserInfoError(502, "malformed_response", `user-info API ${path}: unexpected shape`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function parseMember(v: unknown): Member {
  if (!isRecord(v)) throw malformed("/users/:id");
  const id = str(v, "id");
  const displayName = str(v, "displayName");
  const avatarUrl = str(v, "avatarUrl");
  const githubId = str(v, "githubId");
  if (
    id === undefined ||
    displayName === undefined ||
    avatarUrl === undefined ||
    githubId === undefined
  ) {
    throw malformed("/users/:id");
  }
  return { id, displayName, avatarUrl, githubId };
}

function parseCaller(v: unknown): Caller {
  if (!isRecord(v)) throw malformed("/me");
  const userId = str(v, "userId");
  const role = str(v, "role");
  if (userId === undefined || (role !== "admin" && role !== "member")) throw malformed("/me");
  if (v.kind === "session") return { kind: "session", userId, role };
  if (v.kind === "token") {
    const clientId = str(v, "clientId");
    const jti = str(v, "jti");
    const audiences = Array.isArray(v.audiences) ? v.audiences : undefined;
    if (
      clientId === undefined ||
      jti === undefined ||
      !audiences?.every((a) => typeof a === "string")
    ) {
      throw malformed("/me");
    }
    return { kind: "token", userId, role, clientId, audiences: audiences as string[], jti };
  }
  throw malformed("/me");
}
