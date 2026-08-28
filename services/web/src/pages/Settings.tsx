/** / — you, and every client connected to your account, each with its disconnect. */
import { useCallback, useEffect, useState } from "react";

import type { ConnectedClient } from "../api.ts";
import { formatDate, relative, resourceName, shortId } from "../format.ts";
import { useSession } from "../session.tsx";
import { Avatar, Badge, ErrorNotice, Spinner } from "../ui.tsx";

export function SettingsPage() {
  const { api, session } = useSession();
  const [clients, setClients] = useState<readonly ConnectedClient[] | undefined>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(() => api.myClients().then(setClients, setError), [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function disconnect(clientId: string, name: string) {
    if (!confirm(`Disconnect ${name}? It will have to ask for access again.`)) return;
    setBusy(clientId);
    try {
      await api.disconnectClient(clientId);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(undefined);
    }
  }

  if (!session) return <Spinner />;
  const u = session.user;
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1>
        <span className="person" style={{ display: "inline-flex" }}>
          <Avatar src={u.image} name={u.name} large /> {u.name}
        </span>
      </h1>
      <p className="lede">
        GitHub <code>{u.githubLogin}</code> ·{" "}
        {u.role === "admin" ? <Badge kind="admin">admin</Badge> : <Badge>member</Badge>}
        {" · "}member since {formatDate(u.createdAt)}
      </p>

      <h2>Connected clients</h2>
      <p className="lede">
        Applications you allowed to act as you, and what they may reach. Disconnecting revokes their
        access immediately; a token already issued expires within 15 minutes.
      </p>
      <ErrorNotice error={error} />
      {clients === undefined ? (
        <Spinner />
      ) : clients.length === 0 ? (
        <p className="empty">
          Nothing is connected. Add an MCP server in your editor and it will ask for access here.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>May reach</th>
                <th>Allowed</th>
                <th>Last token</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.clientId}>
                  <td>
                    <div>{c.name ?? "Unnamed client"}</div>
                    <div className="sub mono" title={c.clientId}>
                      {shortId(c.clientId)}
                    </div>
                  </td>
                  <td>{c.resources.map(resourceName).join(", ") || "—"}</td>
                  <td title={formatDate(c.consentedAt)}>{relative(c.consentedAt)}</td>
                  <td title={formatDate(c.lastTokenAt)}>{relative(c.lastTokenAt)}</td>
                  <td className="actions-cell">
                    <button
                      className="btn danger row-action"
                      disabled={busy === c.clientId}
                      onClick={() => disconnect(c.clientId, c.name ?? shortId(c.clientId))}
                    >
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
