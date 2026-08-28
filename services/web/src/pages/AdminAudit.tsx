/** /admin/audit — the append-only record, newest first, one sentence per row. */
import { Button } from "@herkules/ui/components/button";
import { Label } from "@herkules/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@herkules/ui/components/select";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { AuditRow, Member } from "../api.ts";
import { auditGroup, describeAudit, formatDate, userIdsOf } from "../format.ts";
import { Empty, Eyebrow, Lede, Loading, PageTitle } from "../layout.tsx";
import { ErrorNotice } from "../notices.tsx";
import { useSession } from "../session.tsx";

const TYPES = [
  "login",
  "gate.rejected",
  "gate.stale_allow",
  "token.issued",
  "consent.granted",
  "consent.denied",
  "client.registered",
  "client.revoked",
  "client.pruned",
  "admin.role_set",
  "admin.user_disabled",
  "admin.user_enabled",
  "admin.sessions_revoked",
  "admin.allowlist_added",
  "admin.allowlist_removed",
  "admin.seeded",
];
const ALL = "all"; // Radix Select items cannot carry an empty value.

export function AdminAuditPage() {
  const { api } = useSession();
  const [type, setType] = useState(ALL);

  const audit = useInfiniteQuery({
    queryKey: ["admin", "audit", type],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await api.admin.audit({
        type: type === ALL ? undefined : type,
        cursor: pageParam,
        limit: 50,
      });
      // Each page carries the people it names; the merge happens at render.
      const people = await api.membersById(userIdsOf(page.rows));
      return { rows: page.rows, next: page.next, people };
    },
    getNextPageParam: (last) => last.next,
  });

  const rows: AuditRow[] = audit.data?.pages.flatMap((p) => p.rows) ?? [];
  const names = new Map<string, string>();
  for (const p of audit.data?.pages ?? [])
    for (const m of p.people as Member[]) names.set(m.id, m.displayName);

  return (
    <>
      <Eyebrow>Admin</Eyebrow>
      <PageTitle>Audit log</PageTitle>
      <Lede>
        Everything the authorization server did or refused: sign-ins, tokens, consents, client
        registrations and admin actions. Append-only.
      </Lede>
      <div className="mb-4 grid w-fit gap-1.5">
        <Label htmlFor="audit-type">Show</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="audit-type" className="min-w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>everything</SelectItem>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ErrorNotice error={audit.error} />
      {rows.length === 0 ? (
        audit.isPending ? (
          <Loading />
        ) : audit.isError ? null : (
          <Empty>Nothing recorded yet.</Empty>
        )
      ) : (
        <ol className="m-0 list-none rounded-md border border-line bg-surface p-0">
          {rows.map((r) => (
            <li
              key={r.id}
              data-group={auditGroup(r.type)}
              className="grid gap-0.5 border-b border-line-2 px-3.5 py-2.5 text-[0.925rem] last:border-b-0 sm:grid-cols-[9rem_6.5rem_1fr] sm:gap-4"
            >
              <time
                dateTime={r.at}
                title={r.at}
                className="text-muted-foreground tabular-nums whitespace-nowrap"
              >
                {formatDate(r.at)}
              </time>
              <span className="font-mono text-xs text-muted-foreground">{r.type}</span>
              <span>{describeAudit(r, names)}</span>
            </li>
          ))}
        </ol>
      )}
      {audit.hasNextPage ? (
        <div className="mt-4">
          <Button
            variant="outline"
            onClick={() => audit.fetchNextPage()}
            disabled={audit.isFetching}
          >
            Show older
          </Button>
        </div>
      ) : null}
    </>
  );
}
