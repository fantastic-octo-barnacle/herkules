/**
 * Client for the auth service's user-info API, with the caller's own token —
 * this app never holds a credential of its own for user data.
 *
 * A COPY of `services/mcp-directory/src/userinfo.ts`, and that is the point to
 * name rather than hide: the second copy of a protocol is the moment it moves.
 * PLANNED, as the first implementation step of apps/bbs: hoist into
 * `@herkules/auth-middleware/userinfo` (a subpath next to hono/mcp/testing),
 * delete both copies. Until then this file must not grow a feature the
 * directory's copy lacks.
 */
import { z } from "zod";

const memberSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string(),
  githubId: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

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
    const err = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
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
  };
}
