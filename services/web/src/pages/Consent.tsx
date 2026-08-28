/**
 * /consent?<signed query> — the grant as a ledger line: client -> resource.
 * Better Auth sends here with the original authorize parameters signed;
 * we answer with the same query so nothing about the request is ours to trust.
 */
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";

import type { PublicClient, RegistryEntry } from "../api.ts";
import { resourceName } from "../format.ts";
import { useSession } from "../session.tsx";
import { ErrorNotice, Spinner } from "../ui.tsx";

export function ConsentPage() {
  const { api, session } = useSession();
  const [params] = useSearchParams();
  const [client, setClient] = useState<PublicClient | undefined>();
  const [registry, setRegistry] = useState<readonly RegistryEntry[]>([]);
  const [busy, setBusy] = useState<"allow" | "deny" | undefined>();
  const [error, setError] = useState<unknown>();

  const oauthQuery = params.toString();
  const clientId = params.get("client_id") ?? "";
  const resources = params.getAll("resource");
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);

  useEffect(() => {
    if (!session || !clientId) return;
    api.publicClient(clientId).then(setClient, () => setClient(undefined));
    api.registry().then(
      (r) => setRegistry(r.resources),
      () => setRegistry([]),
    );
  }, [api, session, clientId]);

  if (session === undefined) return <Spinner />;
  if (session === null) return <Navigate to={`/login?${oauthQuery}`} replace />;
  if (!clientId || !params.has("sig"))
    return (
      <div className="centered">
        <div className="card">
          <h1>Nothing to approve</h1>
          <p className="lede">
            This page is opened by an application asking for access. Start the connection from your
            editor or client again.
          </p>
        </div>
      </div>
    );

  async function answer(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setError(undefined);
    try {
      const r = await api.consent(accept, oauthQuery);
      const url = r.url ?? r.redirect_uri;
      if (!url) throw new Error("The authorization server returned no redirect.");
      location.href = url;
    } catch (err) {
      setError(err);
      setBusy(undefined);
    }
  }

  const titleOf = (audience: string) =>
    registry.find((e) => e.audience === audience)?.title ?? resourceName(audience);
  const clientName = client?.client_name ?? `client ${clientId}`;

  return (
    <div className="centered">
      <div className="card">
        <p className="eyebrow">Connection request</p>
        <h1>Allow {clientName}?</h1>
        <div className="ledger" aria-label="What will be granted">
          <div className="party">
            <div className="name">{clientName}</div>
            <div className="sub mono">{clientId}</div>
          </div>
          <div className="arrow" aria-hidden="true">
            →
          </div>
          <div className="party right">
            {resources.length === 0 ? (
              <div className="name">your account</div>
            ) : (
              resources.map((r) => (
                <div key={r}>
                  <div className="name">{titleOf(r)}</div>
                  <div className="sub mono">{r}</div>
                </div>
              ))
            )}
          </div>
        </div>
        <p className="lede">
          It will act as <strong>{session.user.name}</strong>
          {scopes.includes("offline_access") ? " and stay connected until you disconnect it" : ""}.
          You can disconnect it any time from Settings.
        </p>
        <ErrorNotice error={error} />
        <div className="actions">
          <button className="btn" onClick={() => answer(false)} disabled={busy !== undefined}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={() => answer(true)}
            disabled={busy !== undefined}
          >
            {busy === "allow" ? "Allowing…" : "Allow"}
          </button>
        </div>
      </div>
    </div>
  );
}
