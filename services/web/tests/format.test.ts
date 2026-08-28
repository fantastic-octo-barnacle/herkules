import { describe, expect, it } from "vite-plus/test";

import type { AuditRow } from "../src/api.ts";
import {
  describeAudit,
  loginErrorMessage,
  relative,
  resourceName,
  userIdsOf,
} from "../src/format.ts";

const row = (event: AuditRow["event"], extra: Partial<AuditRow> = {}): AuditRow => ({
  id: "1",
  at: "2026-08-28T00:00:00Z",
  type: event.type,
  actorUserId: null,
  subjectUserId: null,
  clientId: null,
  event,
  ...extra,
});

describe("format", () => {
  it("names people when known and keeps ids short otherwise", () => {
    const names = new Map([["u_alice_0123456789", "Alice"]]);
    expect(describeAudit(row({ type: "login", userId: "u_alice_0123456789" }), names)).toBe(
      "Alice signed in with GitHub.",
    );
    expect(
      describeAudit(
        row({
          type: "admin.role_set",
          actor: { kind: "user", userId: "u_alice_0123456789" },
          userId: "u_bob_00000000000",
          role: "admin",
          previous: "member",
        }),
        names,
      ),
    ).toBe("Alice changed u_bob_00… from member to admin.");
    expect(
      describeAudit(
        row({
          type: "client.pruned",
          actor: { kind: "system", job: "dcr-prune" },
          clientIds: ["a", "b"],
        }),
        names,
      ),
    ).toBe("System (dcr-prune) removed 2 idle client registrations.");
  });

  it("collects every user id a page mentions", () => {
    expect(
      userIdsOf([
        row({ type: "login", userId: "a" }, { subjectUserId: "a" }),
        row(
          { type: "admin.user_enabled", actor: { kind: "user", userId: "b" }, userId: "c" },
          { actorUserId: "b", subjectUserId: "c" },
        ),
      ]).sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("explains gate rejections without naming the organization", () => {
    expect(loginErrorMessage("not_org_member")).toContain("allowlist");
    expect(loginErrorMessage("x", "Service says so")).toBe("Service says so");
  });

  it("resource names and relative times", () => {
    expect(resourceName("https://herkules.dev/mcp/directory")).toBe("directory");
    expect(resourceName("nonsense")).toBe("nonsense");
    const now = new Date("2026-08-28T12:00:00Z");
    expect(relative("2026-08-28T11:30:00Z", now)).toMatch(/30 minutes ago/);
    expect(relative(null)).toBe("never");
  });
});
