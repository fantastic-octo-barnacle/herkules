/** /admin/audit — the append-only record, newest first, one sentence per row. */
import { useCallback, useEffect, useState } from "react";

import type { AuditRow } from "../api.ts";
import { auditGroup, describeAudit, formatDate, userIdsOf } from "../format.ts";
import { useSession } from "../session.tsx";
import { ErrorNotice, Spinner } from "../ui.tsx";

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

export function AdminAuditPage() {
  const { api } = useSession();
  const [rows, setRows] = useState<readonly AuditRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [next, setNext] = useState<string | undefined>();
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const page = await api.admin.audit({ type: type || undefined, cursor, limit: 50 });
        const unknown = userIdsOf(page.rows).filter((id) => !names.has(id));
        if (unknown.length) {
          const people = await api.membersById(unknown);
          setNames((prev) => {
            const m = new Map(prev);
            for (const p of people) m.set(p.id, p.displayName);
            return m;
          });
        }
        setRows((prev) => (cursor ? [...prev, ...page.rows] : page.rows));
        setNext(page.next);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    // names is read for the lookup only; re-running on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, type],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Audit log</h1>
      <p className="lede">
        Everything the authorization server did or refused: sign-ins, tokens, consents, client
        registrations and admin actions. Append-only.
      </p>
      <div className="toolbar">
        <label className="field">
          <span>Show</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">everything</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNotice error={error} />
      {rows.length === 0 && !loading ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <ol className="audit">
          {rows.map((r) => (
            <li key={r.id} data-group={auditGroup(r.type)}>
              <time dateTime={r.at} title={r.at}>
                {formatDate(r.at)}
              </time>
              <span className="kind">{r.type}</span>
              <span>{describeAudit(r, names)}</span>
            </li>
          ))}
        </ol>
      )}
      {loading ? <Spinner /> : null}
      {next ? (
        <div className="more">
          <button className="btn" onClick={() => load(next)} disabled={loading}>
            Show older
          </button>
        </div>
      ) : null}
    </>
  );
}
