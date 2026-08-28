/**
 * Client for the auth service's user-info API (services/auth/DESIGN.md: any
 * registry audience is accepted there, so the caller's own token is forwarded
 * unchanged — this server never holds a credential of its own).
 *
 * Every method returns a value or throws `UserInfoError`: a tool handler maps
 * that to an MCP error result. Response shapes are checked, not trusted.
 */
import { z } from "zod";

const memberSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string(),
  githubId: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

const callerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), userId: z.string(), role: z.enum(["admin", "member"]) }),
  z.object({
    kind: z.literal("token"),
    userId: z.string(),
    role: z.enum(["admin", "member"]),
    clientId: z.string(),
    audiences: z.array(z.string()),
    jti: z.string(),
  }),
]);

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
  /** GET /auth/api/me: how the issuer sees this token (role from the row, so a demotion shows immediately). */
  me(token: string): Promise<z.infer<typeof callerSchema>>;
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
      return status === 404 ? undefined : memberSchema.parse(body);
    },
    async members(token) {
      const { body } = await call(token, "/users");
      return z.object({ users: z.array(memberSchema) }).parse(body).users;
    },
    async me(token) {
      const { body } = await call(token, "/me");
      return callerSchema.parse(body);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
