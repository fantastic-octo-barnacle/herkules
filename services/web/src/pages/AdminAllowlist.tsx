/** /admin/allowlist — GitHub logins admitted without organization membership. */
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatDate } from "../format.ts";
import { Empty, Eyebrow, Lede, Loading, PageTitle } from "../layout.tsx";
import { ErrorNotice } from "../notices.tsx";
import { useSession } from "../session.tsx";

const KEY = ["admin", "allowlist"] as const;

export function AdminAllowlistPage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [note, setNote] = useState("");

  const allowlist = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const entries = await api.admin.allowlist();
      const people = await api.membersById([...new Set(entries.map((e) => e.addedBy))]);
      return { entries, names: new Map(people.map((p) => [p.id, p.displayName])) };
    },
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: () => api.admin.allowlistAdd(login.trim(), note.trim() || undefined),
    onSuccess: () => {
      setLogin("");
      setNote("");
      return invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (githubLogin: string) => api.admin.allowlistRemove(githubLogin),
    onSuccess: invalidate,
  });
  const busy = add.isPending || remove.isPending;
  const error = allowlist.error ?? add.error ?? remove.error;

  return (
    <>
      <Eyebrow>Admin</Eyebrow>
      <PageTitle>Allowlist</PageTitle>
      <Lede>
        GitHub accounts admitted even when they are not members of the team's organization. Checked
        at every sign-in and every token refresh.
      </Lede>
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="allow-login">GitHub login</Label>
          <Input
            id="allow-login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            pattern="[A-Za-z0-9-]{1,39}"
            placeholder="octocat"
          />
        </div>
        <div className="grid min-w-48 flex-1 gap-1.5">
          <Label htmlFor="allow-note">Note (optional)</Label>
          <Input
            id="allow-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="contractor until October"
          />
        </div>
        <Button type="submit" disabled={busy || !login.trim()}>
          Add to allowlist
        </Button>
      </form>
      <ErrorNotice error={error} />
      {allowlist.data === undefined ? (
        allowlist.isError ? null : (
          <Loading />
        )
      ) : allowlist.data.entries.length === 0 ? (
        <Empty>The allowlist is empty; only organization members can sign in.</Empty>
      ) : (
        <div className="rounded-md border border-line bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GitHub login</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Added</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {allowlist.data.entries.map((e) => (
                <TableRow key={e.githubLogin}>
                  <TableCell>
                    <code>{e.githubLogin}</code>
                  </TableCell>
                  <TableCell>{e.note ?? "—"}</TableCell>
                  <TableCell>
                    {formatDate(e.addedAt)} by {allowlist.data.names.get(e.addedBy) ?? e.addedBy}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            `Remove ${e.githubLogin} from the allowlist? They keep access only while in the organization.`,
                          )
                        )
                          remove.mutate(e.githubLogin);
                      }}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
