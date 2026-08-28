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
import type { AuthDb, ClientRow } from "./db/index.ts";
import { hashClientSecret } from "./secrets.ts";

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
 * First-party clients, created idempotently at boot. Two kinds:
 *  - public: PKCE only, no secret (`herkules-web`, the SPA's dev-token client).
 *  - confidential: `client_secret_basic`, refresh tokens, a secret from config
 *    (`bbs`, the BFF of apps/bbs on its own origin — packages/oauth-client).
 * Both skip consent (first party) and are `native` so the http://localhost dev
 * redirect and the https prod redirect are both registrable (the stored
 * applicationType only gates DCR validation; authorize matches redirect URIs
 * exactly — tests/first-party.test.ts). `redirectUris(config)` returning []
 * (origin not configured) skips the entry with a log line, as does a
 * confidential entry whose `secret(config)` is unset.
 */
interface FirstPartyClientBase {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: (config: Config) => readonly string[];
  readonly skipConsent: boolean;
  readonly applicationType: "web" | "native";
  readonly grantTypes: readonly ("authorization_code" | "refresh_token")[];
  readonly metadata?: Record<string, unknown>;
}

export type FirstPartyClient =
  | (FirstPartyClientBase & { readonly tokenEndpointAuthMethod: "none" })
  | (FirstPartyClientBase & {
      readonly tokenEndpointAuthMethod: "client_secret_basic";
      /** Undefined = not configured for this deployment: the entry is skipped. */
      readonly secret: (config: Config) => string | undefined;
    });

export const FIRST_PARTY_CLIENTS = [
  {
    clientId: "herkules-web",
    name: "herkules web",
    redirectUris: (c) => [`${c.PUBLIC_ORIGIN}/dev-token/callback`],
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
  {
    clientId: "bbs",
    name: "RM 文库",
    redirectUris: (c) => (c.BBS_ORIGIN ? [`${c.BBS_ORIGIN}/callback`] : []),
    skipConsent: true,
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "native",
    grantTypes: ["authorization_code", "refresh_token"],
    secret: (c) => c.BBS_CLIENT_SECRET,
  },
] as const satisfies readonly FirstPartyClient[];

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

/** The row a first-party entry must be, as a projection comparable to `ClientRow`. */
interface WantedClient {
  readonly clientId: string;
  readonly name: string;
  readonly clientSecret: string | null;
  readonly redirectUris: readonly string[];
  readonly skipConsent: boolean;
  readonly tokenEndpointAuthMethod: string;
  readonly applicationType: string;
  readonly grantTypes: readonly string[];
  readonly metadata: Record<string, unknown> | null;
}

/** Resolves the checked-in entries against config; entries this deployment does not configure are dropped (with a reason). */
export async function wantedFirstPartyClients(
  config: Config,
): Promise<{ readonly wanted: readonly WantedClient[]; readonly skipped: readonly string[] }> {
  const wanted: WantedClient[] = [];
  const skipped: string[] = [];
  for (const c of FIRST_PARTY_CLIENTS as readonly FirstPartyClient[]) {
    const redirectUris = c.redirectUris(config);
    if (redirectUris.length === 0) {
      skipped.push(`${c.clientId}: origin not configured`);
      continue;
    }
    let clientSecret: string | null = null;
    if (c.tokenEndpointAuthMethod === "client_secret_basic") {
      const secret = c.secret(config);
      if (secret === undefined) {
        skipped.push(`${c.clientId}: secret not configured`);
        continue;
      }
      clientSecret = await hashClientSecret(secret);
    }
    wanted.push({
      clientId: c.clientId,
      name: c.name,
      clientSecret,
      redirectUris,
      skipConsent: c.skipConsent,
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      applicationType: c.applicationType,
      grantTypes: [...c.grantTypes],
      metadata: c.metadata ?? null,
    });
  }
  for (const c of STATIC_CLIENTS) {
    wanted.push({
      clientId: c.clientId,
      name: c.name,
      clientSecret: null,
      redirectUris: [...c.redirectUris],
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      grantTypes: ["authorization_code", "refresh_token"],
      metadata: null,
    });
  }
  return { wanted, skipped };
}

function sameClient(existing: ClientRow, w: WantedClient): boolean {
  return (
    existing.name === w.name &&
    existing.clientSecret === w.clientSecret &&
    existing.redirectUris.join(" ") === w.redirectUris.join(" ") &&
    existing.skipConsent === w.skipConsent &&
    existing.tokenEndpointAuthMethod === w.tokenEndpointAuthMethod &&
    existing.applicationType === w.applicationType &&
    existing.grantTypes.join(" ") === w.grantTypes.join(" ") &&
    JSON.stringify(existing.metadata) === JSON.stringify(w.metadata)
  );
}

/**
 * Idempotent: looks each wanted row up by clientId, inserts it when absent (a
 * direct insert: Better Auth's admin endpoint generates its own client_id, and
 * the apps need stable ones), and rewrites EVERY reconciled field when any
 * differs — a half-deployed row with the wrong auth method or a stale secret
 * hash would 401 forever otherwise. Secrets are stored hashed (secrets.ts).
 */
export async function ensureFirstPartyClients(
  db: AuthDb,
  config: Config,
  now: () => Date,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const { wanted, skipped } = await wantedFirstPartyClients(config);
  for (const reason of skipped) log(`first-party client skipped — ${reason}`);
  for (const w of wanted) {
    const existing = await db.clients.byId(w.clientId);
    if (!existing) {
      const at = now();
      await db.clients.insert({
        id: crypto.randomUUID(),
        clientId: w.clientId,
        clientSecret: w.clientSecret,
        name: w.name,
        redirectUris: [...w.redirectUris],
        skipConsent: w.skipConsent,
        tokenEndpointAuthMethod: w.tokenEndpointAuthMethod,
        applicationType: w.applicationType,
        grantTypes: [...w.grantTypes],
        responseTypes: ["code"],
        requirePKCE: true,
        disabled: false,
        metadata: w.metadata,
        createdAt: at,
        updatedAt: at,
      });
    } else if (!sameClient(existing, w)) {
      await db.clients.update(w.clientId, {
        name: w.name,
        clientSecret: w.clientSecret,
        redirectUris: w.redirectUris,
        skipConsent: w.skipConsent,
        tokenEndpointAuthMethod: w.tokenEndpointAuthMethod,
        applicationType: w.applicationType,
        grantTypes: w.grantTypes,
        metadata: w.metadata ?? undefined,
      });
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
