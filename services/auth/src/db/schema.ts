/**
 * Drizzle schema = Better Auth's generated tables + ours. Better Auth's part
 * is GENERATED (scripts/generate-schema.ts -> schema.auth.ts, from
 * getAuthTables(authOptions()) because the CLI lags core); never hand-edited.
 * Ours are declared here. `npx drizzle-kit generate` diffs both into
 * services/auth/drizzle/*.sql, applied at boot by db/index.ts.
 */
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export * from "./schema.auth.ts"; // user, session, account, verification, jwks, oauthClient, oauthAccessToken, oauthRefreshToken, oauthConsent, oauthResource, ...

/** GitHub logins admitted without org membership. Lower-cased. */
export const allowlist = pgTable(
  "allowlist",
  {
    githubLogin: text("github_login").primaryKey(),
    note: text("note"),
    addedBy: text("added_by").notNull(), // user.id
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("allowlist_login_ci").on(t.githubLogin)],
);

/** Append-only. No UPDATE/DELETE grants for the service role in prod (see tools/deploy). */
export const audit = pgTable(
  "audit",
  {
    id: text("id").primaryKey(), // uuid v7 (time-ordered) so (at, id) keyset paging is stable
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    actorUserId: text("actor_user_id"),
    subjectUserId: text("subject_user_id"),
    clientId: text("client_id"),
    event: jsonb("event").notNull(), // the AuditEvent
  },
  (t) => [
    index("audit_at").on(t.at, t.id),
    index("audit_subject").on(t.subjectUserId, t.at),
    index("audit_type").on(t.type, t.at),
  ],
);
