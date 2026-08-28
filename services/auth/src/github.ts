/**
 * The only module that talks to GitHub. Owns the wire shapes; hands out domain
 * values. `fetch` is the single injected seam, so tests run against a fake
 * GitHub and production against the network, with the same code between.
 */

export interface GithubApi {
  /**
   * Is the token's user an active member of `org`?
   * GET /user/memberships/orgs/{org} -> 200 active | 200 pending -> "none" | 404 -> "none".
   * "unknown" for network errors, 5xx and timeouts (10 s); "revoked" for 401 (the user
   * un-authorized our OAuth app, or the stored token is dead). Never throws.
   */
  orgMembership(accessToken: string, org: string): Promise<OrgMembership>;
  /** GET /user -> the raw profile Better Auth expects from getUserInfo. `null` on any failure (BA treats it as a failed login). */
  profile(accessToken: string): Promise<GithubProfile | null>;
  /** Streams an avatar for the cache. Returns null on failure; the caller keeps the previous file. */
  avatar(
    url: string,
  ): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly contentType: string } | null>;
}

export type OrgMembership = "active" | "none" | "unknown" | "revoked";

/** Subset of the GitHub /user payload we read. Wire type: stays inside github.ts and gate.ts. */
export interface GithubProfile {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly avatar_url: string;
}

export interface GithubApiOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createGithubApi(options: GithubApiOptions = {}): GithubApi {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  const call = async (path: string, accessToken: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`https://api.github.com${path}`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "herkules-auth",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async orgMembership(accessToken, org) {
      try {
        const res = await call(`/user/memberships/orgs/${encodeURIComponent(org)}`, accessToken);
        switch (res.status) {
          case 200: {
            const body = (await res.json()) as { state?: unknown };
            return body.state === "active" ? "active" : "none";
          }
          case 404:
            return "none";
          case 401:
            return "revoked";
          default:
            return "unknown"; // 403 (scope missing), 5xx, rate limited: cannot verify
        }
      } catch {
        return "unknown";
      }
    },
    async profile(accessToken) {
      try {
        const res = await call("/user", accessToken);
        if (res.status !== 200) return null;
        const body = (await res.json()) as Partial<GithubProfile>;
        if (
          typeof body.id !== "number" ||
          typeof body.login !== "string" ||
          typeof body.avatar_url !== "string"
        ) {
          return null;
        }
        return {
          id: body.id,
          login: body.login,
          name: typeof body.name === "string" ? body.name : null,
          email: typeof body.email === "string" ? body.email : null,
          avatar_url: body.avatar_url,
        };
      } catch {
        return null;
      }
    },
    async avatar(url) {
      try {
        const res = await fetchImpl(url, { headers: { "user-agent": "herkules-auth" } });
        if (!res.ok || !res.body) return null;
        return { body: res.body, contentType: res.headers.get("content-type") ?? "image/png" };
      } catch {
        return null;
      }
    },
  };
}

/**
 * GitHub returns `email: null` for users with a private email. Better Auth requires
 * a unique email; we do not use email for anything, so synthesize GitHub's own
 * noreply form rather than spend a second API call on /user/emails.
 */
export function emailFor(profile: GithubProfile): string {
  return profile.email ?? `${profile.id}+${profile.login}@users.noreply.github.com`;
}
