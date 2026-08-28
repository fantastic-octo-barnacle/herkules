/** /admin/allowlist — GitHub logins admitted without organization membership. */
import { useCallback, useEffect, useState } from "react";

import type { AllowlistEntry, Member } from "../api.ts";
import { formatDate } from "../format.ts";
import { useSession } from "../session.tsx";
import { ErrorNotice, Spinner } from "../ui.tsx";

export function AdminAllowlistPage() {
  const { api } = useSession();
  const [entries, setEntries] = useState<readonly AllowlistEntry[] | undefined>();
  const [names, setNames] = useState<ReadonlyMap<string, Member>>(new Map());
  const [login, setLogin] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const load = useCallback(async () => {
    try {
      const list = await api.admin.allowlist();
      setEntries(list);
      const people = await api.membersById([...new Set(list.map((e) => e.addedBy))]);
      setNames(new Map(people.map((p) => [p.id, p])));
    } catch (err) {
      setError(err);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.admin.allowlistAdd(login.trim(), note.trim() || undefined);
      setLogin("");
      setNote("");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function remove(githubLogin: string) {
    if (
      !confirm(
        `Remove ${githubLogin} from the allowlist? They keep access only while in the organization.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.admin.allowlistRemove(githubLogin);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Allowlist</h1>
      <p className="lede">
        GitHub accounts admitted even when they are not members of the team's organization. Checked
        at every sign-in and every token refresh.
      </p>
      <form className="toolbar" onSubmit={add}>
        <label className="field">
          <span>GitHub login</span>
          <input
            className="input"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            pattern="[A-Za-z0-9-]{1,39}"
            placeholder="octocat"
          />
        </label>
        <label className="field grow">
          <span>Note (optional)</span>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="contractor until October"
          />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !login.trim()}>
          Add to allowlist
        </button>
      </form>
      <ErrorNotice error={error} />
      {entries === undefined ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="empty">The allowlist is empty; only organization members can sign in.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>GitHub login</th>
                <th>Note</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.githubLogin}>
                  <td>
                    <code>{e.githubLogin}</code>
                  </td>
                  <td>{e.note ?? "—"}</td>
                  <td>
                    {formatDate(e.addedAt)} by {names.get(e.addedBy)?.displayName ?? e.addedBy}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="btn danger row-action"
                      disabled={busy}
                      onClick={() => remove(e.githubLogin)}
                    >
                      Remove
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
