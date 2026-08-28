/**
 * The Better Auth instance: every plugin option, hook and callback in one
 * readable place. This file IS the authorization server; the rest of the
 * service is what Better Auth cannot do (registry PRM, audited admin ops,
 * user-info, avatars).
 *
 * Reading order for the two flows that matter:
 *   login:   socialProviders.github.getUserInfo (gate.stampLogin: allowlist first, then org check — has the token;
 *            also copies the stamp onto the returned user, which is how additional fields reach the row)
 *            -> user.validateUserInfo (reads the stamp; rejects + audits)
 *            -> databaseHooks.user.create.before (seed admin role from env)
 *            -> hooks.after "/callback/:id" (login audit, avatar refresh)
 *   grant:   customTokenResponseFields (gate.recheck on EVERY grant; throw = clean invalid_grant)
 *            -> customAccessTokenClaims (role stamp)
 *            -> hooks.after "/oauth2/token" (token.issued audit)
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";

import type { Audit } from "./audit.ts";
import { auditAfterHook } from "./audit.ts";
import { isDevTokenClient, registerBeforeHook } from "./clients.ts";
import { clientSecretStore } from "./secrets.ts";
import type { Config } from "./config.ts";
import type { AuthDb } from "./db/index.ts";
import * as schema from "./db/schema.ts";
import type { Gate, GateReason } from "./gate.ts";
import { gateUserRowOf, isStamped } from "./gate.ts";
import { emailFor } from "./github.ts";
import type { GithubApi } from "./github.ts";
import type { Registry } from "./registry.ts";
import type { Role } from "./users.ts";
import { roleOf } from "./users.ts";

const DAY = 86_400;

export interface AuthDeps {
  readonly config: Config;
  readonly db: AuthDb;
  readonly registry: Registry;
  readonly gate: Gate;
  readonly audit: Audit;
  readonly github: GithubApi;
  readonly now: () => Date;
  /** Called after a login completes (avatar refresh). Injected to keep users.ts/avatars.ts out of this file's imports. */
  readonly onLogin: (userId: string) => Promise<void>;
}

/**
 * Endpoints we refuse to expose. Better Auth matches these EXACTLY (no globs:
 * the router does `disabledPaths.includes(normalizedPath)`), so every admin
 * mutation is listed by name. Every mutation goes through /auth/api/admin
 * (audited, transactional); the admin plugin stays for the role/banned columns
 * and its session-create ban check only.
 */
export const DISABLED_PATHS: readonly string[] = [
  "/token", //                 jwt plugin's session->JWT mint; only oauth2/token issues access tokens (and it would carry no aud)
  "/update-user", //           additional fields are input:true so mapProfileToUser can set them; nobody else may
  "/delete-user", //           FRAME: disable, never delete (audit integrity)
  "/change-email",
  "/oauth2/delete-consent", // replaced by /auth/api/me/clients/:id (also revokes refresh tokens + audits)
  "/admin/set-role",
  "/admin/ban-user", //        ban without refresh-token revocation leaves the IDE working for 30 days
  "/admin/unban-user",
  "/admin/create-user", //     GitHub is the only way in
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/update-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/list-users", //      reads too: one admin surface, with our projection (connected clients, last login)
  "/admin/get-user",
  "/admin/list-user-sessions",
  "/admin/has-permission",
];

/** Options the schema generator and the runtime must agree on: build once, use in both. */
export function authOptions(deps: AuthDeps) {
  const { config, registry, gate, audit } = deps;
  const recordAudit = auditAfterHook(audit);
  return {
    appName: "herkules",
    baseURL: config.issuer, // path in baseURL wins over basePath -> handler mounts at /auth/*
    secret: config.AUTH_SECRET,
    database: drizzleAdapter(deps.db, { provider: "pg", schema }),
    trustedOrigins: [config.PUBLIC_ORIGIN],
    disabledPaths: [...DISABLED_PATHS],
    onAPIError: { errorURL: "/login" }, // gate rejections land on the SPA login page as ?error=<code>&error_description=

    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        scope: ["read:org"], // appended to read:user,user:email
        overrideUserInfoOnSignIn: true, // name/image/githubLogin mirrored from GitHub each login (FRAME)
        /**
         * The gate's EVIDENCE half runs here and nowhere else: this is the only
         * callback that holds the fresh GitHub token before the account row exists.
         * Returns { user, data }; `data` becomes validateUserInfo's `source.oauth.profile`.
         */
        getUserInfo: async (tokens) => {
          if (!tokens.accessToken) return null;
          const profile = await gate.stampLogin(tokens.accessToken);
          if (!profile) return null;
          const { verdict, checkedAt } = profile.herkules;
          return {
            user: {
              // No `id`: Better Auth derives the account subject from the provider's numeric profile id itself.
              name: profile.name ?? profile.login,
              email: emailFor(profile),
              image: profile.avatar_url,
              emailVerified: true,
              // Every other key lands on the user row as an additional field (input: true), on create AND on
              // each returning sign-in (overrideUserInfoOnSignIn). mapProfileToUser is NOT called when
              // getUserInfo is overridden, so the stamp is copied here.
              githubLogin: profile.login,
              githubId: String(profile.id),
              ...(verdict.ok ? { admittedVia: verdict.via, gateCheckedAt: checkedAt } : {}),
            },
            // Our stamped subset rides where Better Auth expects GitHub's full wire profile; only validateUserInfo reads it.
            data: profile as never,
          };
        },
      },
    },

    user: {
      additionalFields: {
        githubLogin: { type: "string", required: true, input: true },
        githubId: { type: "string", required: true, input: true },
        admittedVia: {
          type: ["admin", "allowlist", "org", "org-stale"] as const,
          required: false,
          input: true,
        },
        gateCheckedAt: { type: "number", required: false, input: true }, // epoch seconds
      },
      /**
       * The gate's DECISION half: enforced on create-user, link-account and
       * every returning sign-in. Reads the stamp; never calls GitHub.
       * Returning { error } sends the browser to onAPIError.errorURL.
       */
      validateUserInfo: async ({ source }) => {
        const oauth = source.method === "oauth" ? source.oauth : undefined;
        if (!oauth || oauth.providerId !== "github") {
          return {
            error: "unsupported_login",
            errorDescription: "Only GitHub sign-in is supported.",
          };
        }
        const p: unknown = oauth.profile;
        if (!isStamped(p))
          return { error: "server_error", errorDescription: "Sign-in could not be verified." };
        const { verdict } = p.herkules;
        if (verdict.ok) return undefined;
        await gate.reject(
          { githubLogin: p.login, githubId: String(p.id) },
          verdict.reason,
          "login",
        );
        return { error: verdict.reason, errorDescription: DESCRIPTIONS[verdict.reason] };
      },
    },
    account: { updateAccountOnSignIn: true }, // stored GitHub token refreshed each login; gate.recheck reads it

    session: {
      expiresIn: 30 * DAY,
      updateAge: 1 * DAY,
      // No cookieCache: it would keep a disabled user's browser session alive for
      // its maxAge on every device — exactly the lag Users.setDisabled exists to
      // remove. Postgres is on the same box; one session read per request is fine.
    },

    databaseHooks: {
      user: {
        create: {
          /** Seed: an env-listed login is CREATED as admin. Payload role beats the admin plugin's defaultRole. Never demotes (users.ts). */
          before: async (user) => {
            const login =
              typeof user.githubLogin === "string" ? user.githubLogin.toLowerCase() : "";
            if (login && config.ADMIN_GITHUB_LOGINS.includes(login))
              return { data: { ...user, role: "admin" } };
            return undefined;
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only one before-hook is allowed; branch by path. Client quirks live in clients.ts.
        if (ctx.path === "/oauth2/register") return registerBeforeHook(ctx);
        return undefined;
      }),
      after: createAuthMiddleware(async (ctx) => {
        await recordAudit(ctx); // login / token / consent / register rows (awaited)
        if (ctx.path === "/callback/:id" && ctx.context.newSession) {
          await deps.onLogin(ctx.context.newSession.user.id);
        }
      }),
    },

    plugins: [
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" }, gracePeriod: 30 * DAY }, // rotation stays manual in v1; verifiers already select by kid
        jwt: { issuer: config.issuer },
        disableSettingJwtHeader: true,
      }),
      admin({
        defaultRole: "member" satisfies Role,
        adminRoles: ["admin" satisfies Role],
        // No adminUserIds: the env seeds the role column instead, so there is one source of authority (the row).
      }),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: registry.canonical.audience,
        resources: [...registry.oauthResources()], // mcp() appends `resource` again and dedupes; overwrite mode makes the registry authoritative
        resourceSeedMode: "overwrite",
        cachedResources: new Set(registry.audiences), // no oauth_resource read per token request
        enforcePerClientResources: false, // FRAME: any IDE client may request any registry resource; consent is still per client per resource (Better Auth re-prompts for a new resource)
        /**
         * AS vocabulary. MCP resources never grant openid/profile/email: the
         * per-resource allowedScopes filter (registry.ts) intersects them away,
         * which keeps `aud` a single string and mints no id_token. The OIDC
         * scopes stay advertised for future first-party OIDC clients (the BBS).
         */
        scopes: ["openid", "profile", "email", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 30 * DAY,
        refreshTokenReuseInterval: 30,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true, // Claude Code registers with no credentials
        clientRegistrationRequirePKCE: true,
        storeTokens: "hashed",
        storeClientSecret: clientSecretStore, // secrets.ts owns the format; clients.ts seeds rows with the same function
        rateLimit: { register: { window: 3600, max: 20 } }, // IDEs re-register per session; 5/min default is too tight for a team behind one NAT
        /**
         * The grant re-check, for EVERY grant type. Runs before any token is
         * created, with the DB user row but no request context; the gate
         * reaches DB/GitHub through its own closures (allowlist + ban are local
         * rows; GitHub only when the cached verdict is older than
         * GATE_RECHECK_TTL). Throwing rejects the grant cleanly as
         * invalid_grant; gate.reject has already revoked the refresh family and
         * written the audit row.
         */
        customTokenResponseFields: async ({ grantType, user, metadata }) => {
          if (grantType === "refresh_token" && isDevTokenClient(metadata)) {
            throw new APIError("BAD_REQUEST", {
              error: "unauthorized_client",
              error_description: "Dev tokens cannot be refreshed. Mint a new one.",
            });
          }
          if (!user) return {};
          const row = gateUserRowOf(user); // boundary: throws (500) on a row the gate never admitted
          const verdict = await gate.recheck(row);
          if (verdict.ok) return {};
          await gate.reject(
            {
              githubLogin: row.githubLogin,
              githubId: typeof user.githubId === "string" ? user.githubId : "",
              userId: row.id,
            },
            verdict.reason,
            "grant",
          );
          throw new APIError("BAD_REQUEST", {
            error: "invalid_grant",
            error_description: DESCRIPTIONS[verdict.reason],
          });
        },
        /** Role stamp. `user` is the DB row; the admin plugin owns `role`. A row without a valid role never becomes a token. */
        customAccessTokenClaims: async ({ user }) => {
          if (!user) throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
          return { role: roleOf(user) };
        },
      }),
      /**
       * CIMD is deliberately NOT mounted (2026-08-28). Claude Code's document
       * registers `http://localhost/callback` and then requests
       * `http://localhost:<random>/callback`; Better Auth's matcher grants RFC
       * 8252 port variance to 127.0.0.1/[::1] only, so every CIMD authorize
       * fails with invalid_redirect. Without the advertisement Claude Code uses
       * DCR, which registers the exact port per run. Re-enable when the matcher
       * accepts `localhost` (import cimd from @better-auth/cimd, fetch guard
       * from @better-auth/cimd/node in production).
       */
    ],

    advanced: {
      cookiePrefix: "herkules",
      useSecureCookies: config.isProduction,
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: config.TRUSTED_PROXIES },
    },
    rateLimit: { enabled: config.isProduction, storage: "memory" }, // one container; plugin per-endpoint rules apply on top
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;

/** Client-visible reason text. Short; never names the org or echoes the login (errorDescription reaches the client). */
export const DESCRIPTIONS: Readonly<Record<GateReason, string>> = {
  not_org_member: "This GitHub account is not permitted to sign in.",
  banned: "This account has been disabled.",
  github_unreachable: "GitHub could not be reached to verify your membership. Try again.",
  github_token_revoked: "Your GitHub authorization was revoked. Sign in again.",
};
