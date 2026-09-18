/** /admin — members: role, disable/enable, sign out everywhere. Every action is one audited call. */
import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Badge } from "@herkules/ui/components/badge";
import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { Label } from "@herkules/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ConfirmDialog } from "../confirm.tsx";
import { formatDate, relative } from "../format.ts";
import { Empty, Eyebrow, Lede, Loading, PageTitle, Sub } from "../layout.tsx";
import { ErrorNotice, Notice } from "../notices.tsx";
import { useSession } from "../session.tsx";

const ADMITTED: Record<string, string> = {
  admin: "seed admin",
  allowlist: "allowlist",
  org: "organization",
  "org-stale": "organization (unconfirmed)",
};
const KEY = ["admin", "users"] as const;

export function AdminUsersPage() {
  const { api, session } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  const users = useInfiniteQuery({
    queryKey: [...KEY, query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.admin.users({ search: query || undefined, cursor: pageParam }),
    getNextPageParam: (last) => last.next,
  });
  /**
   * One audited call, then the list reloads. `variables.id` marks the busy row.
   * A `run` that resolves to a string reports it above the table — the count
   * from "sign out everywhere" is the only outcome the row itself cannot show.
   */
  const [result, setResult] = useState<string | undefined>();
  const act = useMutation({
    mutationFn: ({ run }: { id: string; run: () => Promise<unknown> }) => run(),
    onMutate: () => setResult(undefined),
    onSuccess: (message) => {
      if (typeof message === "string") setResult(message);
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const busyId = act.isPending ? act.variables.id : undefined;

  const rows = users.data?.pages.flatMap((p) => p.rows) ?? [];
  const me = session?.user.id;
  return (
    <>
      <Eyebrow>Admin</Eyebrow>
      <PageTitle>Members</PageTitle>
      <Lede>
        Everyone who has signed in. Disabling ends every session and connected client at once;
        tokens already issued expire within 15 minutes.
      </Lede>
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <div className="grid min-w-48 flex-1 gap-1.5">
          <Label htmlFor="member-search">Search by GitHub login or name</Label>
          <Input id="member-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant="outline" type="submit">
          Search
        </Button>
      </form>
      <ErrorNotice error={users.error ?? act.error} />
      {result ? <Notice kind="ok">{result}</Notice> : null}
      <div className="rounded-md border border-line bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Admitted via</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="text-right">Clients</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex min-w-48 items-center gap-2.5">
                    <Avatar size="sm">
                      <AvatarImage src={u.avatarUrl || undefined} alt="" />
                      <AvatarFallback />
                    </Avatar>
                    <div>
                      <div>
                        {u.displayName}{" "}
                        {u.disabled ? <Badge variant="destructive">disabled</Badge> : null}
                      </div>
                      <Sub>
                        <code>{u.githubLogin || "Feishu account"}</code> · joined{" "}
                        {formatDate(u.createdAt)}
                      </Sub>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {u.role === "admin" ? (
                    <Badge>admin</Badge>
                  ) : (
                    <Badge variant="outline">member</Badge>
                  )}
                </TableCell>
                <TableCell>{u.admittedVia ? ADMITTED[u.admittedVia] : "—"}</TableCell>
                <TableCell title={formatDate(u.lastLoginAt)}>{relative(u.lastLoginAt)}</TableCell>
                <TableCell className="text-right tabular-nums">{u.connectedClients}</TableCell>
                <TableCell className="space-x-1 text-right whitespace-nowrap">
                  {/* Your own role is not yours to change: users.setRole refuses it (self_demote). */}
                  {u.id === me ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title="You cannot demote yourself. Ask another admin."
                    >
                      Make member
                    </Button>
                  ) : (
                    <ConfirmDialog
                      trigger={
                        <Button variant="outline" size="sm" disabled={busyId === u.id}>
                          {u.role === "admin" ? "Make member" : "Make admin"}
                        </Button>
                      }
                      title={
                        u.role === "admin"
                          ? `Make ${u.displayName} a member?`
                          : `Make ${u.displayName} an admin?`
                      }
                      description={
                        u.role === "admin"
                          ? "They lose Members, Allowlist and Audit immediately. Their sessions and connected clients are untouched."
                          : "They gain Members, Allowlist and Audit, and can disable or promote anyone here — you included."
                      }
                      confirmLabel={u.role === "admin" ? "Make member" : "Make admin"}
                      destructive={u.role === "admin"}
                      onConfirm={() =>
                        act.mutate({
                          id: u.id,
                          run: () =>
                            api.admin.setRole(u.id, u.role === "admin" ? "member" : "admin"),
                        })
                      }
                    />
                  )}
                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" size="sm" disabled={busyId === u.id}>
                        Sign out everywhere
                      </Button>
                    }
                    title={`Sign ${u.displayName} out everywhere?`}
                    description="Every browser session ends at once. Connected clients keep their access, and a token already issued expires within 15 minutes."
                    confirmLabel="Sign out everywhere"
                    destructive={false}
                    onConfirm={() =>
                      act.mutate({
                        id: u.id,
                        run: async () => {
                          const r = await api.admin.revokeSessions(u.id);
                          return `${u.displayName}: ${r.count} browser session(s) ended.`;
                        },
                      })
                    }
                  />
                  {u.disabled ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === u.id}
                      onClick={() =>
                        act.mutate({ id: u.id, run: () => api.admin.setDisabled(u.id, false) })
                      }
                    >
                      Enable
                    </Button>
                  ) : u.id === me ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled
                      title="You cannot disable yourself"
                    >
                      Disable
                    </Button>
                  ) : (
                    <ConfirmDialog
                      trigger={
                        <Button variant="destructive" size="sm" disabled={busyId === u.id}>
                          Disable
                        </Button>
                      }
                      title={`Disable ${u.displayName}?`}
                      description="Every session and connected client ends at once and they cannot sign in again. A token already issued expires within 15 minutes."
                      confirmLabel="Disable"
                      field={{ label: "Reason (optional)", placeholder: "left the team" }}
                      onConfirm={(reason) =>
                        act.mutate({
                          id: u.id,
                          run: () => api.admin.setDisabled(u.id, true, reason),
                        })
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length === 0 ? (
        users.isPending ? (
          <Loading />
        ) : users.isError ? null : (
          <Empty>No members match.</Empty>
        )
      ) : null}
      {users.hasNextPage ? (
        <div className="mt-4">
          <Button
            variant="outline"
            onClick={() => users.fetchNextPage()}
            disabled={users.isFetching}
          >
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}
