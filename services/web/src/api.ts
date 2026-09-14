/**
 * Typed client for everything the SPA calls: Better Auth's own routes and the
 * auth service's /auth/api. Same origin, cookie auth; no state here.
 * Every non-2xx answer becomes an ApiError carrying the service's
 * `{ error, error_description }` so pages show the service's words.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type Role = "admin" | "member";

export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly role?: string | null;
  readonly githubLogin: string;
  readonly githubId: string;
  readonly createdAt: string;
}
export interface Session {
  readonly user: SessionUser;
  readonly session: { readonly id: string; readonly expiresAt: string; readonly createdAt: string };
}

export interface Member {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly githubId: string;
}
export interface AdminUserRow extends Member {
  readonly githubLogin: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly admittedVia: "admin" | "allowlist" | "org" | "org-stale" | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly connectedClients: number;
}
export interface ConnectedClient {
  readonly clientId: string;
  readonly name: string | null;
  readonly resources: readonly string[];
  readonly consentedAt: string;
  readonly lastTokenAt: string | null;
}
export interface AllowlistEntry {
  readonly githubLogin: string;
  readonly note: string | null;
  readonly addedBy: string;
  readonly addedAt: string;
}
export type Actor = { kind: "user"; userId: string } | { kind: "system"; job: string };
export interface AuditRow {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly actorUserId: string | null;
  readonly subjectUserId: string | null;
  readonly clientId: string | null;
  readonly event: Record<string, unknown> & { readonly type: string };
}
export interface Page<T> {
  readonly rows: readonly T[];
  readonly next?: string;
}
export interface RegistryEntry {
  readonly name: string;
  readonly kind: "mcp" | "api";
  readonly title: string;
  readonly audience: string;
  readonly metadataUrl: string;
}
export interface Registry {
  readonly issuer: string;
  readonly devTokenClientId: string;
  readonly resources: readonly RegistryEntry[];
}
export interface PublicClient {
  readonly client_id: string;
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
}
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly scope?: string;
}
export type Mutation = { readonly changed: boolean };

type Fetch = typeof globalThis.fetch;

async function request<T>(fetchImpl: Fetch, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchImpl(path, {
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  });
  const text = await res.text();
  const body: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = isRecord(body) ? body : {};
    throw new ApiError(
      res.status,
      typeof err.error === "string" ? err.error : typeof err.code === "string" ? err.code : "error",
      typeof err.error_description === "string"
        ? err.error_description
        : typeof err.message === "string"
          ? err.message
          : `${res.status} ${res.statusText}`,
    );
  }
  // Asset-only previews and misconfigured proxies may return SPA HTML with 200.
  // Never let that masquerade as a typed API response.
  if (text && typeof body === "string") {
    throw new ApiError(
      res.status,
      "invalid_response",
      "The API is unavailable at this address. Please try again from the main site.",
    );
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function createApi(fetchImpl: Fetch = (...args) => globalThis.fetch(...args)) {
  const get = <T>(path: string) => request<T>(fetchImpl, path);
  const send = <T>(method: string, path: string, body?: unknown) =>
    request<T>(fetchImpl, path, { method, ...(body === undefined ? {} : json(body)) });

  return {
    /** null when signed out. */
    session: async (): Promise<Session | null> => {
      const value = await get<unknown>("/auth/get-session");
      if (value === null) return null;
      if (
        !isRecord(value) ||
        !isRecord(value.user) ||
        typeof value.user.id !== "string" ||
        !isRecord(value.session) ||
        typeof value.session.id !== "string"
      ) {
        throw new ApiError(200, "invalid_response", "The API returned an invalid session.");
      }
      return value as unknown as Session;
    },
    /** Returns the GitHub URL to navigate to. `oauthQuery` continues an IDE's authorization after login. */
    signInWithGithub: (callbackURL: string, oauthQuery?: string) =>
      send<{ url: string }>("POST", "/auth/sign-in/social", {
        provider: "github",
        callbackURL,
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
      }),
    signOut: () => send<unknown>("POST", "/auth/sign-out", {}),

    /** Client display fields; the prelogin form needs no session (used on /login?client_id=…). */
    publicClient: (clientId: string, oauthQuery?: string) =>
      oauthQuery
        ? send<PublicClient>("POST", "/auth/oauth2/public-client-prelogin", {
            client_id: clientId,
            oauth_query: oauthQuery,
          })
        : get<PublicClient>(`/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`),
    /** Answers the consent screen; the returned URL is where the browser goes next (client redirect_uri). */
    consent: (accept: boolean, oauthQuery: string) =>
      send<{ url?: string; redirect_uri?: string }>("POST", "/auth/oauth2/consent", {
        accept,
        oauth_query: oauthQuery,
      }),
    /** Authorization-code exchange for the dev-token page (public client, PKCE). */
    token: (form: Record<string, string>) =>
      request<TokenResponse>(fetchImpl, "/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),

    registry: () => get<Registry>("/auth/api/registry"),
    members: () => get<{ users: Member[] }>("/auth/api/users").then((r) => r.users),
    membersById: (ids: readonly string[]) =>
      ids.length === 0
        ? Promise.resolve<Member[]>([])
        : send<{ users: Member[] }>("POST", "/auth/api/users/batch", { ids }).then((r) => r.users),
    myClients: () =>
      get<{ clients: ConnectedClient[] }>("/auth/api/me/clients").then((r) => r.clients),
    disconnectClient: (clientId: string) =>
      send<Mutation>("DELETE", `/auth/api/me/clients/${encodeURIComponent(clientId)}`),

    admin: {
      users: (q: { search?: string; cursor?: string; limit?: number } = {}) =>
        get<Page<AdminUserRow>>(`/auth/api/admin/users?${params(q)}`),
      setRole: (id: string, role: Role) =>
        send<Mutation>("PUT", `/auth/api/admin/users/${encodeURIComponent(id)}/role`, { role }),
      setDisabled: (id: string, disabled: boolean, reason?: string) =>
        send<Mutation>("PUT", `/auth/api/admin/users/${encodeURIComponent(id)}/disabled`, {
          disabled,
          ...(reason ? { reason } : {}),
        }),
      revokeSessions: (id: string) =>
        send<{ count: number }>(
          "DELETE",
          `/auth/api/admin/users/${encodeURIComponent(id)}/sessions`,
        ),
      disconnectClient: (id: string, clientId: string) =>
        send<Mutation>(
          "DELETE",
          `/auth/api/admin/users/${encodeURIComponent(id)}/clients/${encodeURIComponent(clientId)}`,
        ),
      allowlist: () =>
        get<{ entries: AllowlistEntry[] }>("/auth/api/admin/allowlist").then((r) => r.entries),
      allowlistAdd: (githubLogin: string, note?: string) =>
        send<Mutation>(
          "PUT",
          `/auth/api/admin/allowlist/${encodeURIComponent(githubLogin)}`,
          note ? { note } : {},
        ),
      allowlistRemove: (githubLogin: string) =>
        send<Mutation>("DELETE", `/auth/api/admin/allowlist/${encodeURIComponent(githubLogin)}`),
      audit: (q: { cursor?: string; limit?: number; type?: string; userId?: string } = {}) =>
        get<Page<AuditRow>>(`/auth/api/admin/audit?${params(q)}`),
    },
  };
}
export type Api = ReturnType<typeof createApi>;

function params(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
