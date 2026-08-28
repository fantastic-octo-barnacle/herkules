/**
 * What is in each cookie, what the cookies are called, and the Cookie /
 * Set-Cookie codec. The only writer of `Set-Cookie` strings in the package.
 *
 * Two cookies, both sealed (seal.ts), both host-only, `Path=/`, `HttpOnly`,
 * `SameSite=Lax`; `Secure` + `__Host-` prefix when the app origin is https.
 *
 *   hk_session  (30 d)  SessionCookie — the tokens and NOTHING derivable from
 *                       them. No subject, no role, no expiry: identity is
 *                       always re-derived by verification, and the access
 *                       token's own `exp` is the expiry (single source of truth).
 *   hk_login    (10 min) LoginCookie — a bounded list of in-flight login
 *                       attempts, newest first, so a second tab starting a
 *                       login does not break the first, and a replayed callback
 *                       fails locally (state not found) instead of at the issuer.
 */
import type { Purpose, Sealer } from "./seal.ts";

export interface SessionCookie {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** A same-origin path (`/…`, never `//…`, never absolute). Only `safePath` makes one. */
export type SafePath = string & { readonly __safePath: true };

const ROOT = "/" as SafePath;
const MAX_PATH_LENGTH = 2048;

/**
 * Untrusted `next` → SafePath. Anything that is not a single-slash-rooted path
 * (`//host`, `/\host`, `https://…`, control characters, over-long) becomes "/".
 */
export function safePath(raw: string | null | undefined): SafePath {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_LENGTH) return ROOT;
  if (raw.charCodeAt(0) !== 0x2f) return ROOT;
  const second = raw.charCodeAt(1);
  if (second === 0x2f || second === 0x5c) return ROOT; // "//" or "/\"
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return ROOT;
  }
  return raw as SafePath;
}

export interface LoginAttempt {
  readonly state: string;
  readonly codeVerifier: string;
  readonly next: SafePath;
  /** Epoch ms. Attempts older than LOGIN_TTL_MS are dropped on read. */
  readonly issuedAt: number;
}

export interface LoginCookie {
  /** Newest first. At most MAX_LOGIN_ATTEMPTS. */
  readonly attempts: readonly LoginAttempt[];
}

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600; // = issuer refresh token lifetime
export const LOGIN_TTL_MS = 10 * 60_000;
export const MAX_LOGIN_ATTEMPTS = 3;

const SESSION_NAME = "hk_session";
const LOGIN_NAME = "hk_login";

/** Cookie header present but unopenable / malformed: distinguishes "clear it" from "nothing to do". */
export type ReadResult<T> =
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

export interface CookieJar {
  readSession(request: Request): Promise<ReadResult<SessionCookie>>;
  /** A Set-Cookie value carrying the sealed tokens. */
  writeSession(value: SessionCookie): Promise<string>;
  /** A Set-Cookie value with Max-Age=0. */
  clearSession(): string;

  readLogin(request: Request): Promise<ReadResult<LoginCookie>>;
  writeLogin(value: LoginCookie): Promise<string>;
  clearLogin(): string;
}

export interface CookieJarOptions {
  readonly sealer: Sealer;
  /** https origin → `Secure` + `__Host-`. */
  readonly secure: boolean;
  readonly now: () => Date;
}

/** First cookie named `name` in the Cookie header, or undefined. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseSession(json: unknown): SessionCookie | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const { accessToken, refreshToken } = json as Record<string, unknown>;
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) return undefined;
  return { accessToken, refreshToken };
}

function parseLogin(json: unknown): LoginCookie | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const { attempts } = json as Record<string, unknown>;
  if (!Array.isArray(attempts)) return undefined;
  const parsed: LoginAttempt[] = [];
  for (const a of attempts as unknown[]) {
    if (typeof a !== "object" || a === null) return undefined;
    const { state, codeVerifier, next, issuedAt } = a as Record<string, unknown>;
    if (!isNonEmptyString(state) || !isNonEmptyString(codeVerifier)) return undefined;
    if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return undefined;
    parsed.push({
      state,
      codeVerifier,
      next: safePath(typeof next === "string" ? next : "/"),
      issuedAt,
    });
  }
  return { attempts: parsed };
}

export function createCookieJar(options: CookieJarOptions): CookieJar {
  const { sealer, secure, now } = options;
  const prefix = secure ? "__Host-" : "";
  const sessionName = `${prefix}${SESSION_NAME}`;
  const loginName = `${prefix}${LOGIN_NAME}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const attributes = (maxAgeSeconds: number): string =>
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;

  const write = async (name: string, purpose: Purpose, value: unknown, maxAge: number) => {
    const sealed = await sealer.seal(purpose, encoder.encode(JSON.stringify(value)));
    return `${name}=${sealed}; ${attributes(maxAge)}`;
  };

  const read = async <T>(
    request: Request,
    name: string,
    purpose: Purpose,
    parse: (json: unknown) => T | undefined,
  ): Promise<ReadResult<T>> => {
    const raw = readCookie(request, name);
    if (raw === undefined || raw.length === 0) return { kind: "absent" };
    const plain = await sealer.open(purpose, raw);
    if (!plain) return { kind: "invalid" };
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(plain));
    } catch {
      return { kind: "invalid" };
    }
    const value = parse(json);
    return value === undefined ? { kind: "invalid" } : { kind: "present", value };
  };

  return {
    readSession: (request) => read(request, sessionName, "session", parseSession),
    writeSession: (value) =>
      write(
        sessionName,
        "session",
        { accessToken: value.accessToken, refreshToken: value.refreshToken },
        SESSION_MAX_AGE_SECONDS,
      ),
    clearSession: () => `${sessionName}=; ${attributes(0)}`,

    readLogin: async (request) => {
      const r = await read(request, loginName, "login", parseLogin);
      if (r.kind !== "present") return r;
      const cutoff = now().getTime() - LOGIN_TTL_MS;
      return {
        kind: "present",
        value: { attempts: r.value.attempts.filter((a) => a.issuedAt > cutoff) },
      };
    },
    writeLogin: (value) =>
      write(
        loginName,
        "login",
        { attempts: value.attempts.slice(0, MAX_LOGIN_ATTEMPTS) },
        LOGIN_TTL_MS / 1000,
      ),
    clearLogin: () => `${loginName}=; ${attributes(0)}`,
  };
}
