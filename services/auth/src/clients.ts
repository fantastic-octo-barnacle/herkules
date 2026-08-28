/**
 * OAuth client concerns Better Auth gets wrong for IDE clients, kept in one
 * contained place: registration quirks, the redirect-URI policy, the
 * first-party `herkules-web` client, and pruning of abandoned DCR rows.
 *
 * Each quirk is a pure `(RegistrationRequest) => RegistrationRequest | Rejection`
 * so the list can be unit-tested with literals and grown when a client
 * misbehaves, without touching auth.ts.
 */
import { APIError } from "better-auth/api";

import type { Actor, Audit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { AuthDb } from "./db/index.ts";

/** The RFC 7591 fields we inspect. Everything else passes through untouched. */
export interface RegistrationRequest {
  readonly redirect_uris: readonly string[];
  readonly application_type?: "web" | "native";
  readonly client_name?: string;
  readonly [key: string]: unknown;
}

export type Rejection = {
  readonly error: "invalid_redirect_uri" | "invalid_client_metadata";
  readonly error_description: string;
};

export type Quirk = {
  readonly name: string;
  readonly apply: (req: RegistrationRequest) => RegistrationRequest | Rejection;
};

/**
 * FRAME redirect allowlist. `vscode://` is listed for the record: Better Auth
 * rejects authority-bearing private schemes under both application types, so
 * VS Code must (and does, today) use its loopback redirect. Flagged in candidate.md.
 */
export const REDIRECT_ALLOW: readonly RegExp[] = [
  /^http:\/\/localhost(:\d+)?\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,
  /^http:\/\/\[::1\](:\d+)?\//,
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/vscode\.dev\/redirect/,
  /^vscode:\/\//,
];

export const QUIRKS: readonly Quirk[] = [
  {
    // Better Auth defaults dynamic registrations to "web", which rejects loopback redirects.
    // Every DCR client we have is an IDE; native accepts loopback AND https, so always default to it.
    name: "native-by-default",
    apply: (req) => (req.application_type ? req : { ...req, application_type: "native" }),
  },
  {
    name: "redirect-allowlist",
    apply: (req) => {
      const bad = req.redirect_uris.find((u) => !REDIRECT_ALLOW.some((re) => re.test(u)));
      return bad === undefined
        ? req
        : {
            error: "invalid_redirect_uri",
            error_description: `redirect_uri not permitted: ${bad}`,
          };
    },
  },
  // NOT included: "learn-localhost-port" (old repo). Better Auth honours RFC 8252 port variance for
  // 127.0.0.1/[::1] but not the name `localhost`. Add a quirk here only when a real client is shown
  // to register `localhost:<port>` and then listen elsewhere. Open question in candidate.md.
];

/** Pure: runs QUIRKS in order over a registration body. Returns the (possibly rewritten) body or a Rejection. */
export function applyQuirks(body: RegistrationRequest): RegistrationRequest | Rejection {
  let req = body;
  for (const q of QUIRKS) {
    const r = q.apply(req);
    if ("error" in r) return r;
    req = r;
  }
  return req;
}

/**
 * The /oauth2/register branch of the one `hooks.before` middleware. Bodies
 * without a `redirect_uris` array are left for Better Auth's own validator.
 * A Rejection becomes a 400 APIError in RFC 7591 shape.
 */
export function registerBeforeHook(ctx: {
  readonly body?: unknown;
}): { context: { body: RegistrationRequest } } | undefined {
  const body = ctx.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { redirect_uris?: unknown }).redirect_uris)
  ) {
    return undefined;
  }
  const r = applyQuirks(body as RegistrationRequest);
  if ("error" in r) throw new APIError("BAD_REQUEST", r);
  return { context: { body: r } };
}

/**
 * First-party clients, created idempotently at boot. `herkules-web` is the
 * SPA's dev-token client: public, PKCE, skipConsent (first party), native
 * (accepts the http://localhost dev redirect and the https prod one).
 */
export const FIRST_PARTY_CLIENTS = [
  {
    clientId: "herkules-web",
    name: "herkules web",
    redirectPath: "/dev-token/callback",
    skipConsent: true,
    tokenEndpointAuthMethod: "none",
    applicationType: "native",
    grantTypes: ["authorization_code"],
    /**
     * Dev tokens are 15-minute throwaways. Better Auth still mints a refresh
     * token when offline_access is granted and honours it regardless of the
     * client's grant_types, so the refusal lives in customTokenResponseFields,
     * keyed on this metadata (the only client attribute that callback receives).
     */
    metadata: { herkules: { devToken: true } },
  },
] as const;

/** True for the first-party dev-token client, read from the oauthClient.metadata the token callbacks receive. */
export function isDevTokenClient(metadata: Record<string, unknown> | undefined): boolean {
  const h = metadata?.herkules;
  return typeof h === "object" && h !== null && (h as { devToken?: unknown }).devToken === true;
}

export type FirstPartyClientId = (typeof FIRST_PARTY_CLIENTS)[number]["clientId"];

/**
 * Escape hatch for a client whose redirect URI Better Auth's DCR validator
 * rejects (e.g. an authority-bearing `vscode://publisher.ext/cb`): pre-seed it
 * via auth.api.adminCreateOAuthClient, which bypasses the validator, keyed on the
 * client_id the client sends. EMPTY on purpose — the day it needs an entry is the
 * FRAME.md kill-criterion signal (VS Code cannot complete the flow without a
 * library workaround), to be raised, not quietly patched.
 */
export const STATIC_CLIENTS: readonly {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly reason: string;
}[] = [];

/** Every client id this service owns; pruning never touches them. */
export function ownedClientIds(): readonly string[] {
  return [...FIRST_PARTY_CLIENTS.map((c) => c.clientId), ...STATIC_CLIENTS.map((c) => c.clientId)];
}

/**
 * Idempotent: looks each FIRST_PARTY_CLIENTS + STATIC_CLIENTS row up by clientId,
 * inserts the row when absent (a direct insert: Better Auth's admin endpoint
 * generates its own client_id, and the SPA needs a stable one), updates
 * redirect URIs when the origin changed.
 */
export async function ensureFirstPartyClients(
  db: AuthDb,
  config: Config,
  now: () => Date,
): Promise<void> {
  const wanted = [
    ...FIRST_PARTY_CLIENTS.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      redirectUris: [`${config.PUBLIC_ORIGIN}${c.redirectPath}`],
      skipConsent: c.skipConsent,
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      applicationType: c.applicationType,
      grantTypes: [...c.grantTypes],
      metadata: c.metadata as Record<string, unknown>,
    })),
    ...STATIC_CLIENTS.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      redirectUris: [...c.redirectUris],
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      grantTypes: ["authorization_code", "refresh_token"],
      metadata: undefined as Record<string, unknown> | undefined,
    })),
  ];
  for (const w of wanted) {
    const existing = await db.clients.byId(w.clientId);
    if (!existing) {
      const at = now();
      await db.clients.insert({
        id: crypto.randomUUID(),
        clientId: w.clientId,
        name: w.name,
        redirectUris: w.redirectUris,
        skipConsent: w.skipConsent,
        tokenEndpointAuthMethod: w.tokenEndpointAuthMethod,
        applicationType: w.applicationType,
        grantTypes: w.grantTypes,
        responseTypes: ["code"],
        requirePKCE: true,
        disabled: false,
        metadata: w.metadata,
        createdAt: at,
        updatedAt: at,
      });
    } else if (
      existing.redirectUris.join(" ") !== w.redirectUris.join(" ") ||
      JSON.stringify(existing.metadata ?? null) !== JSON.stringify(w.metadata ?? null)
    ) {
      await db.clients.update(w.clientId, { redirectUris: w.redirectUris, metadata: w.metadata });
    }
  }
}

/**
 * Delete DCR/CIMD clients older than DCR_PRUNE_AFTER that own no consent and
 * no live refresh token. Never touches first-party or user-owned clients.
 * Runs at boot and daily. One audit row per sweep that deleted something.
 */
export async function pruneIdleClients(
  db: AuthDb,
  audit: Audit,
  actor: Actor,
  olderThan: Date,
): Promise<number> {
  const clientIds = await db.clients.deleteIdle(olderThan, ownedClientIds());
  if (clientIds.length > 0) await audit.record({ type: "client.pruned", actor, clientIds });
  return clientIds.length;
}
