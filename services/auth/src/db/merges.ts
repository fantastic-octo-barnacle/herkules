/** Session-bound OAuth proofs and transactional merging of an unused duplicate.
 * Application subjects cannot be rewritten here: at most one account may have
 * ever authorized applications. That account keeps its ID; otherwise the older
 * account does. Audit history and the disabled duplicate remain intact.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Audit } from "../audit.ts";
import type { AuthDb } from "./index.ts";
import * as s from "./schema.ts";

const TTL = 10 * 60_000;
const proofSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  sessionId: z.string(),
  provider: z.enum(["github", "feishu"]),
  accountId: z.string(),
  survivorId: z.string().optional(),
});
type Proof = z.infer<typeof proofSchema>;
export class MergeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => {
  throw new MergeError(code, message);
};
const identifier = (sessionId: string) => `identity-merge:${sessionId}`;

export function createMerges(db: AuthDb, audit: Audit, now: () => Date) {
  const readProof = async (tx: AuthDb, sessionId: string, id?: string) => {
    const [row] = await tx
      .select()
      .from(s.verification)
      .where(
        and(
          eq(s.verification.identifier, identifier(sessionId)),
          ...(id ? [eq(s.verification.id, id)] : []),
        ),
      )
      .orderBy(asc(s.verification.createdAt))
      .limit(1);
    if (!row || row.expiresAt <= now())
      return fail("merge_expired", "This merge request expired. Connect the identity again.");
    return { ...row, proof: proofSchema.parse(JSON.parse(row.value)) };
  };
  const plan = async (tx: AuthDb, proof: Proof) => {
    const ids = [proof.sourceId, proof.targetId].sort();
    const rows = await tx
      .select()
      .from(s.user)
      .where(inArray(s.user.id, ids))
      .orderBy(asc(s.user.id))
      .for("update");
    if (rows.length !== 2 || rows.some((u) => u.banned || u.mergedInto))
      return fail(
        "merge_unavailable",
        "One of these accounts is disabled or has already been merged.",
      );
    const accounts = await tx
      .select()
      .from(s.account)
      .where(inArray(s.account.userId, ids))
      .orderBy(asc(s.account.id))
      .for("update");
    // Never combine two identities from the same provider or credential accounts.
    if (
      accounts.length !== 2 ||
      new Set(accounts.map((a) => a.providerId)).size !== 2 ||
      !accounts.every((a) => a.providerId === "github" || a.providerId === "feishu") ||
      !accounts.some(
        (a) =>
          a.userId === proof.targetId &&
          a.providerId === proof.provider &&
          a.accountId === proof.accountId,
      ) ||
      !accounts.some((a) => a.userId === proof.sourceId)
    )
      return fail(
        "merge_identity_conflict",
        "These accounts already have conflicting identities. Contact an administrator.",
      );
    const used = new Set<string>();
    // Audit is append-only, so pruning expired tokens or revoking consent cannot
    // make an account with application history look unused.
    for (const r of await tx
      .selectDistinct({ id: s.audit.subjectUserId })
      .from(s.audit)
      .where(
        and(
          inArray(s.audit.subjectUserId, ids),
          inArray(s.audit.type, ["token.issued", "consent.granted", "identity.application_used"]),
        ),
      ))
      if (r.id) used.add(r.id);
    for (const table of [s.oauthAccessToken, s.oauthRefreshToken, s.oauthConsent, s.oauthClient]) {
      for (const r of await tx
        .selectDistinct({ id: table.userId })
        .from(table)
        .where(inArray(table.userId, ids)))
        if (r.id) used.add(r.id);
    }
    if (used.size > 1)
      return fail(
        "merge_requires_migration",
        "Both accounts have application history. An administrator must migrate that data before they can be merged.",
      );
    const survivor =
      rows.find((u) => used.has(u.id)) ??
      [...rows].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      )[0]!;
    if (proof.survivorId && proof.survivorId !== survivor.id)
      return fail(
        "merge_changed",
        "Account usage changed. Connect the identity again and review the new merge details.",
      );
    const duplicate = rows.find((u) => u.id !== survivor.id)!;
    const feishu = rows.find((u) =>
      accounts.some((a) => a.userId === u.id && a.providerId === "feishu"),
    )!;
    const github = rows.find((u) =>
      accounts.some((a) => a.userId === u.id && a.providerId === "github"),
    )!;
    if (!feishu.feishuTenantKey || !feishu.feishuOpenId || !github.githubId || !github.githubLogin)
      return fail(
        "merge_identity_conflict",
        "The identity records have changed. Connect the identity again.",
      );
    return { survivor, duplicate, feishu, github };
  };
  const activeSession = async (tx: AuthDb, sessionId: string, userId: string) => {
    const [session] = await tx
      .select()
      .from(s.session)
      .where(and(eq(s.session.id, sessionId), eq(s.session.userId, userId)))
      .for("update");
    if (
      !session ||
      session.expiresAt <= now() ||
      now().getTime() - session.createdAt.getTime() > TTL ||
      session.impersonatedBy
    )
      return fail(
        "merge_reauthentication_required",
        "Sign out and sign in again, then retry connecting the identity to merge your accounts.",
      );
  };
  return {
    async markApplicationUse(userId: string) {
      await db.transaction(async (tx) => {
        const u = await tx.users.lock(userId);
        if (!u || u.banned || u.mergedInto)
          return fail("merge_unavailable", "This account is no longer active. Sign in again.");
        const [used] = await tx
          .select({ id: s.audit.id })
          .from(s.audit)
          .where(
            and(eq(s.audit.subjectUserId, userId), eq(s.audit.type, "identity.application_used")),
          )
          .limit(1);
        if (!used) await audit.record({ type: "identity.application_used", userId }, tx);
      });
    },
    async prepare(
      sessionId: string,
      sourceId: string,
      provider: "github" | "feishu",
      accountId: string,
    ) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select()
          .from(s.account)
          .where(and(eq(s.account.providerId, provider), eq(s.account.accountId, accountId)));
        if (!owner || owner.userId === sourceId) return false;
        await activeSession(tx, sessionId, sourceId);
        const proof: Proof = { sessionId, sourceId, targetId: owner.userId, provider, accountId };
        const planned = await plan(tx, proof);
        proof.survivorId = planned.survivor.id;
        await tx.delete(s.verification).where(eq(s.verification.identifier, identifier(sessionId)));
        await tx.insert(s.verification).values({
          id: randomUUID(),
          identifier: identifier(sessionId),
          value: JSON.stringify(proof),
          createdAt: now(),
          updatedAt: now(),
          expiresAt: new Date(now().getTime() + TTL),
        });
        return true;
      });
    },
    async preview(sessionId: string, sourceId: string) {
      return db.transaction(async (tx) => {
        await activeSession(tx, sessionId, sourceId);
        const row = await readProof(tx, sessionId);
        if (row.proof.sourceId !== sourceId)
          return fail("merge_unavailable", "This request belongs to another session.");
        const p = await plan(tx, row.proof);
        return {
          id: row.id,
          expiresAt: row.expiresAt.toISOString(),
          retainedAccount: { id: p.survivor.id, name: p.survivor.name },
          githubLogin: p.github.githubLogin!,
          feishuName: p.feishu.name,
        };
      });
    },
    async cancel(sessionId: string) {
      await db.transaction(async (tx) => {
        // Serialize cancellation with preparation/confirmation for this session.
        await tx
          .select({ id: s.session.id })
          .from(s.session)
          .where(eq(s.session.id, sessionId))
          .for("update");
        await tx.delete(s.verification).where(eq(s.verification.identifier, identifier(sessionId)));
      });
    },
    async confirm(sessionId: string, sourceId: string, id: string) {
      return db.transaction(async (tx) => {
        await activeSession(tx, sessionId, sourceId);
        const row = await readProof(tx, sessionId, id);
        if (row.proof.sourceId !== sourceId)
          return fail("merge_unavailable", "This request belongs to another session.");
        const { survivor, duplicate, feishu, github } = await plan(tx, row.proof);
        const ids = [survivor.id, duplicate.id];
        // Keep a tombstone and immutable audit trail, and release the unique
        // email before assigning Feishu's canonical profile to the survivor.
        await tx
          .update(s.user)
          .set({
            banned: true,
            banReason: "Account merged",
            mergedInto: survivor.id,
            email: `${duplicate.id}@merged.invalid`,
            emailVerified: false,
            githubId: null,
            githubLogin: null,
            feishuTenantKey: null,
            feishuOpenId: null,
            admittedVia: null,
            gateCheckedAt: null,
            updatedAt: now(),
          })
          .where(eq(s.user.id, duplicate.id));
        await tx
          .update(s.account)
          .set({ userId: survivor.id, updatedAt: now() })
          .where(eq(s.account.userId, duplicate.id));
        await tx
          .update(s.user)
          .set({
            name: feishu.name,
            email: feishu.email,
            emailVerified: false,
            image: feishu.image,
            feishuTenantKey: feishu.feishuTenantKey,
            feishuOpenId: feishu.feishuOpenId,
            githubId: github.githubId,
            githubLogin: github.githubLogin,
            role: [survivor.role, duplicate.role].includes("admin") ? "admin" : "member",
            githubConnectionOffered: true,
            gateCheckedAt: null,
            updatedAt: now(),
          })
          .where(eq(s.user.id, survivor.id));
        await tx
          .update(s.oauthAccessToken)
          .set({ revoked: now() })
          .where(inArray(s.oauthAccessToken.userId, ids));
        await tx
          .update(s.oauthRefreshToken)
          .set({ revoked: now(), rotationReplayResponse: null, rotationReplayExpiresAt: null })
          .where(inArray(s.oauthRefreshToken.userId, ids));
        await tx.delete(s.session).where(inArray(s.session.userId, ids));
        await tx.delete(s.verification).where(eq(s.verification.id, row.id));
        await audit.record(
          {
            type: "identity.merged",
            actor: { kind: "user", userId: sourceId },
            userId: survivor.id,
            previousUserId: duplicate.id,
          },
          tx,
        );
        return { ok: true as const };
      });
    },
  };
}
export type Merges = ReturnType<typeof createMerges>;
