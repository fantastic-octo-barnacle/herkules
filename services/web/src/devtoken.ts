/**
 * The dev-token page's flow, framework-free so it is testable against the
 * real auth service: PKCE pair -> authorize URL (browser navigates) ->
 * callback code -> token. State lives in sessionStorage-like storage passed
 * in, keyed by `state`, so a stale callback cannot use a fresh verifier.
 */
import type { Api, TokenResponse } from "./api.ts";

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Pending {
  readonly state: string;
  readonly verifier: string;
  readonly audience: string;
  readonly clientId: string;
}

const KEY = "herkules.devtoken";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function redirectUriFor(origin: string): string {
  return `${origin}/dev-token/callback`;
}

/** Builds the authorize URL and remembers the verifier. The caller navigates to the URL. */
export async function beginDevToken(
  storage: KeyValue,
  input: { origin: string; clientId: string; audience: string },
): Promise<string> {
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const pending: Pending = { state, verifier, audience: input.audience, clientId: input.clientId };
  storage.setItem(KEY, JSON.stringify(pending));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: redirectUriFor(input.origin),
    resource: input.audience,
    // The only scope the registry allows per resource. Omitting `scope` makes Better Auth apply
    // its OIDC defaults and mint an array `aud` that includes its own userinfo endpoint.
    scope: "offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${input.origin}/auth/oauth2/authorize?${q.toString()}`;
}

export type CallbackOutcome =
  | { readonly ok: true; readonly token: TokenResponse; readonly audience: string }
  | { readonly ok: false; readonly error: string; readonly description: string };

/** Completes the flow from the callback's query. One-shot: the pending record is removed first. */
export async function finishDevToken(
  storage: KeyValue,
  api: Api,
  input: { origin: string; search: string },
): Promise<CallbackOutcome> {
  const q = new URLSearchParams(input.search);
  const raw = storage.getItem(KEY);
  storage.removeItem(KEY);
  const pending = raw ? (JSON.parse(raw) as Pending) : undefined;
  if (q.get("error"))
    return {
      ok: false,
      error: q.get("error") ?? "error",
      description: q.get("error_description") ?? "The authorization server refused the request.",
    };
  const code = q.get("code");
  if (!pending || !code || q.get("state") !== pending.state)
    return {
      ok: false,
      error: "invalid_state",
      description:
        "This callback does not match a dev-token request started in this tab. Start again.",
    };
  const token = await api.token({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUriFor(input.origin),
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  return { ok: true, token, audience: pending.audience };
}

/** Decode (not verify) a JWT payload for display. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
