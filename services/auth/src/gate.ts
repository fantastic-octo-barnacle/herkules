/**
 * The identity gate. Owns one question — "may this GitHub user hold a herkules
 * identity right now, and via which door?" — and answers it in three places
 * that must agree: first login, every returning login, every token grant.
 *
 * Shape: `decide()` is the pure policy. `Gate` collects evidence (allowlist row
 * FIRST — no network — then GitHub org membership, env admins, banned flag) and
 * runs `decide` on it. The verdict is carried on the GitHub profile
 * (`profile.herkules`) between the provider's getUserInfo (which holds the
 * token) and validateUserInfo (which can reject and has the request), so the
 * org check runs at most once per login and validateUserInfo never touches GitHub.
 *
 * Invariants: a verdict is never "unknown" — GitHub failure resolves to a
 * decision by policy (fail closed at login; bounded grace at grant time). The
 * user row's `admittedVia`/`gateCheckedAt` are written only here. Every
 * rejection writes its audit row before the caller learns of it.
 */
import type { Audit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { AuthDb } from "./db/index.ts";
import type { GithubApi, GithubProfile, OrgMembership } from "./github.ts";

/** Which door admitted the user. Stored on the user row and stamped in audit rows. `org-stale` = prior org verdict kept during a GitHub outage. */
export type AdmittedVia =
  | "admin"
  | "allowlist"
  | "org"
  | "org-stale"
  | "feishu-tenant"
  | "feishu-allowlist";

export type GateReason =
  | "github_email_required"
  | "not_org_member" //  GitHub says no active membership and no allowlist row
  | "banned" //          admin disabled the user (also enforced by the admin plugin's session hook)
  | "github_unreachable" // could not verify and no fresh prior verdict to lean on
  | "github_token_revoked"; // stored GitHub token is dead; user must log in again

export type Verdict =
  | { readonly ok: true; readonly via: AdmittedVia }
  | { readonly ok: false; readonly reason: GateReason };

export type GatePhase = "login" | "grant";

/** Everything `decide` needs. Collected by `Gate`, fabricated by tests. */
export interface Evidence {
  readonly login: string;
  readonly envAdmin: boolean;
  readonly allowlisted: boolean;
  readonly banned: boolean;
  /** "unknown" when GitHub was not consulted (allowlisted users skip the call) or failed. */
  readonly org: OrgMembership;
  /** Last stored verdict, for the grant-time grace rule. Absent at first login. */
  readonly prior?: { readonly via: AdmittedVia; readonly checkedAt: Date };
  readonly phase: GatePhase;
  readonly now: Date;
  readonly staleMaxSeconds: number;
}

/**
 * Pure policy. Precedence: banned > envAdmin > allowlist > org.
 *  - org "active"  -> ok via org
 *  - org "none"    -> not_org_member
 *  - org "revoked" -> github_token_revoked (grant only; at login the token is seconds old)
 *  - org "unknown" -> login: github_unreachable (fail closed; user retries)
 *                     grant: keep `prior` as via "org-stale" if now - checkedAt <= staleMax, else github_unreachable
 */
export function decide(e: Evidence): Verdict {
  if (e.banned) return { ok: false, reason: "banned" };
  if (e.envAdmin) return { ok: true, via: "admin" };
  if (e.allowlisted) return { ok: true, via: "allowlist" };
  switch (e.org) {
    case "active":
      return { ok: true, via: "org" };
    case "none":
      return { ok: false, reason: "not_org_member" };
    case "revoked":
      return { ok: false, reason: "github_token_revoked" };
    case "unknown": {
      if (e.phase === "login" || !e.prior) return { ok: false, reason: "github_unreachable" };
      const ageSeconds = (e.now.getTime() - e.prior.checkedAt.getTime()) / 1000;
      return ageSeconds <= e.staleMaxSeconds
        ? { ok: true, via: "org-stale" }
        : { ok: false, reason: "github_unreachable" };
    }
  }
}

/**
 * What rides on the raw GitHub profile from getUserInfo to validateUserInfo/mapProfileToUser.
 * Better Auth passes `data` through `toOAuthProfileRecord`, so keep it JSON-plain: no Date, epoch seconds.
 */
export interface GateStamp {
  readonly verdict: Verdict;
  readonly checkedAt: number;
}
export type StampedProfile = GithubProfile & { readonly herkules: GateStamp };

export function isStamped(profile: unknown): profile is StampedProfile {
  if (typeof profile !== "object" || profile === null) return false;
  const p = profile as Record<string, unknown>;
  if (typeof p.login !== "string" || typeof p.id !== "number") return false;
  const h = p.herkules;
  if (typeof h !== "object" || h === null) return false;
  const { verdict, checkedAt } = h as Record<string, unknown>;
  if (typeof checkedAt !== "number" || typeof verdict !== "object" || verdict === null)
    return false;
  const v = verdict as Record<string, unknown>;
  return v.ok === true ? isAdmittedVia(v.via) : v.ok === false && typeof v.reason === "string";
}

const ADMITTED_VIA: readonly AdmittedVia[] = [
  "admin",
  "allowlist",
  "org",
  "org-stale",
  "feishu-tenant",
  "feishu-allowlist",
];
export function isAdmittedVia(value: unknown): value is AdmittedVia {
  return typeof value === "string" && (ADMITTED_VIA as readonly string[]).includes(value);
}

/** The user-row projection the gate reads at grant time. Matches user.additionalFields in auth.ts. */
export interface GateUserRow {
  readonly id: string;
  readonly githubLogin: string;
  readonly feishuTenantKey?: string | null;
  readonly feishuOpenId?: string | null;
  readonly banned?: boolean | null;
  readonly admittedVia?: AdmittedVia | null;
  readonly gateCheckedAt?: number | null; // epoch seconds
}

/** Boundary: the untyped `user` Better Auth hands to token callbacks -> GateUserRow. Throws when githubLogin is missing (a row the gate never admitted). */
export function gateUserRowOf(user: Record<string, unknown>): GateUserRow {
  if (
    typeof user.id !== "string" ||
    (!(typeof user.githubLogin === "string" && user.githubLogin.length > 0) &&
      !(typeof user.feishuTenantKey === "string" && typeof user.feishuOpenId === "string"))
  ) {
    throw new Error("gate: user row was never admitted (missing githubLogin)");
  }
  return {
    id: user.id,
    githubLogin: typeof user.githubLogin === "string" ? user.githubLogin : "",
    feishuTenantKey: typeof user.feishuTenantKey === "string" ? user.feishuTenantKey : null,
    feishuOpenId: typeof user.feishuOpenId === "string" ? user.feishuOpenId : null,
    banned: user.banned === true,
    admittedVia: isAdmittedVia(user.admittedVia) ? user.admittedVia : null,
    gateCheckedAt: typeof user.gateCheckedAt === "number" ? user.gateCheckedAt : null,
  };
}

export interface Gate {
  /**
   * Login path. Called from the GitHub provider's getUserInfo override with the
   * fresh access token: fetch profile, check the allowlist (no network), only
   * then ask GitHub for org membership, decide, stamp.
   * Returns null only when the profile itself cannot be fetched.
   */
  stampLogin(accessToken: string): Promise<StampedProfile | null>;

  /**
   * Grant path, every grant type. No request context exists here (called from
   * the provider's customTokenResponseFields): banned and allowlist are local
   * rows; honours GATE_RECHECK_TTL (skip GitHub when the last verdict is fresh),
   * else reads the stored GitHub token from the account row, re-asks, persists
   * the new verdict on the user row, returns it. Never throws for policy.
   */
  recheck(user: GateUserRow): Promise<Verdict>;

  /**
   * Record a rejection: audit row (awaited, never background) and, on the
   * grant path, revoke the user's refresh-token families so the IDE stops
   * retrying and falls back to a browser login. Idempotent.
   */
  reject(
    subject: { readonly githubLogin: string; readonly githubId: string; readonly userId?: string },
    reason: GateReason,
    phase: GatePhase,
  ): Promise<void>;
}

export interface GateDeps {
  readonly config: Config;
  readonly db: AuthDb;
  readonly github: GithubApi;
  readonly audit: Audit;
  readonly now: () => Date;
}

export function createGate(deps: GateDeps): Gate {
  const { config, db, github, audit, now } = deps;
  const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
  const isEnvAdmin = (login: string) => config.ADMIN_GITHUB_LOGINS.includes(login.toLowerCase());
  const priorOf = (
    row: { admittedVia?: AdmittedVia | null; gateCheckedAt?: number | null } | undefined,
  ) =>
    row?.admittedVia && row.gateCheckedAt != null
      ? { via: row.admittedVia, checkedAt: new Date(row.gateCheckedAt * 1000) }
      : undefined;

  return {
    async stampLogin(accessToken) {
      const profile = await github.profile(accessToken);
      if (!profile) return null;
      const [allowlisted, row] = await Promise.all([
        db.allowlist.has(profile.login),
        db.users.byGithubId(String(profile.id)),
      ]);
      const envAdmin = isEnvAdmin(profile.login);
      const org: OrgMembership =
        allowlisted || envAdmin
          ? "unknown"
          : await github.orgMembership(accessToken, config.GITHUB_ORG);
      const at = now();
      const verdict = decide({
        login: profile.login,
        envAdmin,
        allowlisted,
        banned: row?.banned ?? false,
        org,
        prior: priorOf(row),
        phase: "login",
        now: at,
        staleMaxSeconds: config.GATE_STALE_MAX,
      });
      return { ...profile, herkules: { verdict, checkedAt: epoch(at) } };
    },

    async recheck(user) {
      if (user.banned) return { ok: false, reason: "banned" };
      const at = now();
      const fresh =
        user.gateCheckedAt != null && epoch(at) - user.gateCheckedAt <= config.GATE_RECHECK_TTL;
      if (fresh && user.admittedVia && user.admittedVia !== "org-stale")
        return { ok: true, via: user.admittedVia };

      const allowlisted = await db.allowlist.has(user.githubLogin);
      const envAdmin = isEnvAdmin(user.githubLogin);
      let org: OrgMembership = "unknown";
      if (!allowlisted && !envAdmin) {
        const token = await db.accounts.githubAccessToken(user.id);
        org = token ? await github.orgMembership(token, config.GITHUB_ORG) : "revoked";
      }
      const prior = priorOf(user);
      const verdict = decide({
        login: user.githubLogin,
        envAdmin,
        allowlisted,
        banned: false,
        org,
        prior,
        phase: "grant",
        now: at,
        staleMaxSeconds: config.GATE_STALE_MAX,
      });
      if (verdict.ok) {
        // A stale allow keeps the OLD timestamp so the grace window cannot be extended by refreshing.
        await db.users.writeGate(
          user.id,
          verdict,
          verdict.via === "org-stale" && prior ? prior.checkedAt : at,
        );
        if (verdict.via === "org-stale")
          await audit.record({ type: "gate.stale_allow", userId: user.id });
      }
      return verdict;
    },

    async reject(subject, reason, phase) {
      await audit.record({
        type: "gate.rejected",
        githubLogin: subject.githubLogin,
        githubId: subject.githubId,
        ...(subject.userId ? { userId: subject.userId } : {}),
        reason,
        phase,
      });
      if (phase === "grant" && subject.userId)
        await db.tokens.revokeAllRefreshTokens(subject.userId);
    },
  };
}
