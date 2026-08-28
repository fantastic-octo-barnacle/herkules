/** / — you, and every client connected to your account, each with its disconnect. */
import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Badge } from "@herkules/ui/components/badge";
import { Button } from "@herkules/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@herkules/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { formatDate, relative, resourceName, shortId } from "../format.ts";
import { Empty, Eyebrow, Lede, Loading, PageTitle, SectionTitle, Sub } from "../layout.tsx";
import { ErrorNotice } from "../notices.tsx";
import { useSession } from "../session.tsx";

const KEY = ["me", "clients"] as const;

export function SettingsPage() {
  const { api, session } = useSession();
  const queryClient = useQueryClient();
  const clients = useQuery({ queryKey: KEY, queryFn: () => api.myClients() });
  const disconnect = useMutation({
    mutationFn: (clientId: string) => api.disconnectClient(clientId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (!session) return <Loading />;
  const u = session.user;
  const error = clients.error ?? disconnect.error;
  return (
    <>
      <Eyebrow>Settings</Eyebrow>
      <PageTitle>
        <span className="inline-flex items-center gap-3">
          <Avatar size="lg">
            <AvatarImage src={u.image ?? undefined} alt="" />
            <AvatarFallback />
          </Avatar>
          {u.name}
        </span>
      </PageTitle>
      <Lede>
        GitHub <code>{u.githubLogin}</code> ·{" "}
        {u.role === "admin" ? <Badge>admin</Badge> : <Badge variant="outline">member</Badge>}
        {" · "}member since {formatDate(u.createdAt)}
      </Lede>

      <SectionTitle>Connected clients</SectionTitle>
      <Lede>
        Applications you allowed to act as you, and what they may reach. Disconnecting revokes their
        access immediately; a token already issued expires within 15 minutes.
      </Lede>
      <ErrorNotice error={error} />
      {clients.data === undefined ? (
        clients.isError ? null : (
          <Loading />
        )
      ) : clients.data.length === 0 ? (
        <Empty>
          Nothing is connected. Add an MCP server in your editor and it will ask for access here.
        </Empty>
      ) : (
        <div className="rounded-md border border-line bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>May reach</TableHead>
                <TableHead>Allowed</TableHead>
                <TableHead>Last token</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.data.map((c) => (
                <TableRow key={c.clientId}>
                  <TableCell>
                    <div>{c.name ?? "Unnamed client"}</div>
                    <Sub className="font-mono" title={c.clientId}>
                      {shortId(c.clientId)}
                    </Sub>
                  </TableCell>
                  <TableCell>{c.resources.map(resourceName).join(", ") || "—"}</TableCell>
                  <TableCell title={formatDate(c.consentedAt)}>{relative(c.consentedAt)}</TableCell>
                  <TableCell title={formatDate(c.lastTokenAt)}>{relative(c.lastTokenAt)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={disconnect.isPending && disconnect.variables === c.clientId}
                      onClick={() => {
                        const name = c.name ?? shortId(c.clientId);
                        if (confirm(`Disconnect ${name}? It will have to ask for access again.`))
                          disconnect.mutate(c.clientId);
                      }}
                    >
                      Disconnect
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
