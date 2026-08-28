/**
 * Words for what the service records. One sentence per audit event, names
 * resolved by the caller (ids stay visible in mono when unknown).
 */
import type { AuditRow } from "./api.ts";

export type Names = ReadonlyMap<string, string>;

const REASONS: Record<string, string> = {
  not_org_member: "not a member of the team's GitHub organization and not on the allowlist",
  banned: "the account is disabled",
  github_unreachable: "GitHub could not be reached to confirm membership",
  org_stale: "membership could not be re-confirmed in time",
};

export function loginErrorMessage(error: string, description?: string | null): string {
  if (description) return description;
  return REASONS[error] ?? `Sign-in failed (${error}).`;
}

export function describeAudit(row: AuditRow, names: Names): string {
  const e = row.event;
  const who = (id: unknown) =>
    typeof id === "string" ? (names.get(id) ?? shortId(id)) : "someone";
  const actor = (): string => {
    const a = e.actor as { kind?: string; userId?: string; job?: string } | undefined;
    if (!a) return "System";
    return a.kind === "user" ? who(a.userId) : `System (${a.job ?? "job"})`;
  };
  const client = () =>
    typeof e.clientId === "string" ? `client ${shortId(e.clientId)}` : "a client";
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : "");
  switch (e.type) {
    case "login":
      return `${who(e.userId)} signed in with GitHub.`;
    case "gate.rejected":
      return `Sign-in refused for ${str(e.githubLogin) ?? who(e.userId)}: ${REASONS[str(e.reason) ?? ""] ?? str(e.reason)} (at ${str(e.phase) ?? "login"}).`;
    case "gate.stale_allow":
      return `${who(e.userId)} kept access on a previous membership check because GitHub was unreachable.`;
    case "token.issued":
      return `${who(e.userId)} received a token for ${list(e.audiences)} via ${client()} (${str(e.grantType)}).`;
    case "consent.granted":
      return `${who(e.userId)} allowed ${client()} to access ${list(e.resources)}.`;
    case "consent.denied":
      return `${who(e.userId)} denied ${client()}.`;
    case "client.registered":
      return `${str(e.name) ?? "A client"} registered (${str(e.discovery)}) as ${client()}.`;
    case "client.revoked":
      return `${actor()} disconnected ${client()} from ${who(e.userId)}.`;
    case "client.pruned":
      return `${actor()} removed ${Array.isArray(e.clientIds) ? e.clientIds.length : 0} idle client registrations.`;
    case "admin.role_set":
      return `${actor()} changed ${who(e.userId)} from ${str(e.previous)} to ${str(e.role)}.`;
    case "admin.user_disabled":
      return `${actor()} disabled ${who(e.userId)}${e.reason ? ` (${str(e.reason)})` : ""}; ${num(e.sessionsRevoked)} sessions and ${num(e.refreshTokensRevoked)} refresh tokens revoked.`;
    case "admin.user_enabled":
      return `${actor()} re-enabled ${who(e.userId)}.`;
    case "admin.sessions_revoked":
      return `${actor()} signed ${who(e.userId)} out of ${num(e.count)} browser sessions.`;
    case "admin.allowlist_added":
      return `${actor()} added ${str(e.githubLogin)} to the allowlist${e.note ? ` (${str(e.note)})` : ""}.`;
    case "admin.allowlist_removed":
      return `${actor()} removed ${str(e.githubLogin)} from the allowlist.`;
    case "admin.seeded":
      return `${str(e.githubLogin)} was made an admin from ADMIN_GITHUB_LOGINS.`;
    default:
      return `${e.type}`;
  }
}

export function auditGroup(type: string): "access" | "tokens" | "clients" | "admin" {
  if (type.startsWith("admin.")) return "admin";
  if (type.startsWith("client.")) return "clients";
  if (type.startsWith("token.") || type.startsWith("consent.")) return "tokens";
  return "access";
}

/** Every user id an audit row mentions, for one batch lookup per page. */
export function userIdsOf(rows: readonly AuditRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.actorUserId) ids.add(r.actorUserId);
    if (r.subjectUserId) ids.add(r.subjectUserId);
    const uid = r.event.userId;
    if (typeof uid === "string") ids.add(uid);
  }
  return [...ids];
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function resourceName(audience: string): string {
  try {
    const path = new URL(audience).pathname;
    return path.replace(/^\/(mcp|api)\//, "").replace(/\/$/, "") || audience;
  } catch {
    return audience;
  }
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "never";
  return dateFmt.format(new Date(iso));
}

export function relative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  const abs = Math.abs(s);
  const unit =
    abs < 60
      ? [s, "second"]
      : abs < 3600
        ? [Math.round(s / 60), "minute"]
        : abs < 86400
          ? [Math.round(s / 3600), "hour"]
          : [Math.round(s / 86400), "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    -(unit[0] as number),
    unit[1] as Intl.RelativeTimeFormatUnit,
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
