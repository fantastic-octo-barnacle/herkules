/** /admin — members: role, disable/enable, sign out everywhere. Every action is one audited call. */
import { useCallback, useEffect, useState } from "react";

import type { AdminUserRow } from "../api.ts";
import { formatDate, relative } from "../format.ts";
import { useSession } from "../session.tsx";
import { Avatar, Badge, ErrorNotice, Spinner } from "../ui.tsx";

const ADMITTED: Record<string, string> = {
  admin: "seed admin",
  allowlist: "allowlist",
  org: "organization",
  "org-stale": "organization (unconfirmed)",
};

export function AdminUsersPage() {
  const { api, session } = useSession();
  const [rows, setRows] = useState<readonly AdminUserRow[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<unknown>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const page = await api.admin.users({ search: search || undefined, cursor });
        setRows((prev) => (cursor ? [...prev, ...page.rows] : page.rows));
        setNext(page.next);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, search],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(undefined);
    }
  }

  const me = session?.user.id;
  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Members</h1>
      <p className="lede">
        Everyone who has signed in. Disabling ends every session and connected client at once;
        tokens already issued expire within 15 minutes.
      </p>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="field grow">
          <span>Search by GitHub login or name</span>
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button className="btn" type="submit">
          Search
        </button>
      </form>
      <ErrorNotice error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Admitted via</th>
              <th>Last sign-in</th>
              <th className="num">Clients</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="person">
                    <Avatar src={u.avatarUrl} name={u.displayName} />
                    <div>
                      <div>
                        {u.displayName} {u.disabled ? <Badge kind="off">disabled</Badge> : null}
                      </div>
                      <div className="sub">
                        <code>{u.githubLogin}</code> · joined {formatDate(u.createdAt)}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  {u.role === "admin" ? <Badge kind="admin">admin</Badge> : <Badge>member</Badge>}
                </td>
                <td>{u.admittedVia ? ADMITTED[u.admittedVia] : "—"}</td>
                <td title={formatDate(u.lastLoginAt)}>{relative(u.lastLoginAt)}</td>
                <td className="num">{u.connectedClients}</td>
                <td className="actions-cell">
                  <button
                    className="btn row-action"
                    disabled={busy === u.id}
                    onClick={() =>
                      act(u.id, () =>
                        api.admin.setRole(u.id, u.role === "admin" ? "member" : "admin"),
                      )
                    }
                  >
                    {u.role === "admin" ? "Make member" : "Make admin"}
                  </button>{" "}
                  <button
                    className="btn row-action"
                    disabled={busy === u.id}
                    onClick={() =>
                      act(u.id, async () => {
                        const r = await api.admin.revokeSessions(u.id);
                        alert(`${u.displayName}: ${r.count} browser session(s) ended.`);
                      })
                    }
                  >
                    Sign out everywhere
                  </button>{" "}
                  {u.disabled ? (
                    <button
                      className="btn row-action"
                      disabled={busy === u.id}
                      onClick={() => act(u.id, () => api.admin.setDisabled(u.id, false))}
                    >
                      Enable
                    </button>
                  ) : (
                    <button
                      className="btn danger row-action"
                      disabled={busy === u.id || u.id === me}
                      title={u.id === me ? "You cannot disable yourself" : undefined}
                      onClick={() => {
                        const reason = prompt(`Disable ${u.displayName}? Reason (optional):`);
                        if (reason === null) return;
                        void act(u.id, () =>
                          api.admin.setDisabled(u.id, true, reason || undefined),
                        );
                      }}
                    >
                      Disable
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="empty">No members match.</p>
      ) : null}
      {next ? (
        <div className="more">
          <button className="btn" onClick={() => load(next)} disabled={loading}>
            Show more
          </button>
        </div>
      ) : null}
    </>
  );
}
