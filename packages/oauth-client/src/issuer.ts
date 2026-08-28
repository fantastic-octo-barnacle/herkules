/**
 * The issuer as this package sees it: derived endpoints and the token
 * endpoint. The only module that builds `client_secret_basic` or parses the
 * token wire JSON; nothing wire-shaped leaves it.
 *
 * Endpoints are DERIVED from the issuer URL, not discovered. The issuer is
 * ours and its paths are fixed; discovery at boot would add a startup network
 * dependency for no information. `Endpoints` is the seam a `discover()` would
 * fill if the issuer ever stopped being ours.
 */

export interface Endpoints {
  /** Browser-facing: `${issuer}/oauth2/authorize`. */
  readonly authorize: string;
  /** Server-to-server, via `issuerInternal`: `${internal}/oauth2/token`. */
  readonly token: string;
  readonly revoke: string;
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

export function endpointsFor(issuer: string, issuerInternal: string): Endpoints {
  const pub = trimSlashes(issuer);
  const internal = trimSlashes(issuerInternal);
  return {
    authorize: `${pub}/oauth2/authorize`,
    token: `${internal}/oauth2/token`,
    revoke: `${internal}/oauth2/revoke`,
  };
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * Closed classification of a token-endpoint call. `rejected` is the issuer
 * saying no (invalid_grant: revoked, replayed late, gate failed, bad code);
 * `client_auth` is OUR misconfiguration (401 Basic: wrong client secret or
 * auth method) and must never be treated as the user's fault; `unavailable`
 * is network / 5xx / unparseable.
 */
export type GrantResult =
  | { readonly kind: "tokens"; readonly tokens: TokenSet }
  | { readonly kind: "rejected"; readonly error: string; readonly description?: string }
  | { readonly kind: "client_auth"; readonly description?: string }
  | { readonly kind: "unavailable"; readonly cause: unknown };

export interface IssuerClient {
  /** `grant_type=authorization_code`. `resource` is deliberately NOT sent: the token inherits the authorize-time binding (RFC 8707 subset rule). */
  exchange(code: string, codeVerifier: string): Promise<GrantResult>;
  /** `grant_type=refresh_token`. Every call rotates at this issuer; see session.ts for the policy. */
  refresh(refreshToken: string): Promise<GrantResult>;
  /** RFC 7009. Best effort: resolves `true` on 200, `false` otherwise; never throws. */
  revoke(refreshToken: string): Promise<boolean>;
}

export interface IssuerClientOptions {
  readonly endpoints: Endpoints;
  readonly client: { readonly id: string; readonly secret: string };
  readonly redirectUri: string;
  readonly fetch: typeof globalThis.fetch;
}

/** RFC 6749 §2.3.1: id and secret are form-urlencoded before base64. */
export function basicAuthorization(id: string, secret: string): string {
  const pair = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

interface WireError {
  readonly error?: unknown;
  readonly error_description?: unknown;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function createIssuerClient(options: IssuerClientOptions): IssuerClient {
  const { endpoints, redirectUri } = options;
  const authorization = basicAuthorization(options.client.id, options.client.secret);

  const post = async (url: string, form: Record<string, string>): Promise<Response> =>
    options.fetch(url, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    });

  const grant = async (form: Record<string, string>): Promise<GrantResult> => {
    let res: Response;
    try {
      res = await post(endpoints.token, form);
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return {
        kind: "unavailable",
        cause: new Error(`token endpoint ${res.status}: ${String(cause)}`),
      };
    }
    const wire = (typeof body === "object" && body !== null ? body : {}) as WireError &
      Record<string, unknown>;
    if (res.ok) {
      const accessToken = asString(wire.access_token);
      const refreshToken = asString(wire.refresh_token);
      if (!accessToken) {
        return { kind: "unavailable", cause: new Error("token endpoint 200 without access_token") };
      }
      if (!refreshToken) {
        // Config bug (the client lacks refresh_token, or offline_access was filtered): loud, never silent.
        return {
          kind: "unavailable",
          cause: new Error("issuer did not grant offline_access: no refresh_token in the response"),
        };
      }
      return { kind: "tokens", tokens: { accessToken, refreshToken } };
    }
    const error = asString(wire.error);
    const description = asString(wire.error_description);
    if (res.status === 401 || error === "invalid_client") {
      return { kind: "client_auth", ...(description ? { description } : {}) };
    }
    if (res.status >= 400 && res.status < 500 && error) {
      return { kind: "rejected", error, ...(description ? { description } : {}) };
    }
    return {
      kind: "unavailable",
      cause: new Error(`token endpoint ${res.status}${error ? ` ${error}` : ""}`),
    };
  };

  return {
    exchange: (code, codeVerifier) =>
      grant({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    refresh: (refreshToken) => grant({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async revoke(refreshToken) {
      try {
        const res = await post(endpoints.revoke, {
          token: refreshToken,
          token_type_hint: "refresh_token",
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
