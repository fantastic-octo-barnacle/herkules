/**
 * /login — plain, or with Better Auth's signed OAuth query when an IDE's
 * authorization needs a session first. Rejections from the gate arrive as
 * /login?error=…&error_description=… and are shown in the service's words.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import type { PublicClient } from "../api.ts";
import { loginErrorMessage } from "../format.ts";
import { safeNext, useSession } from "../session.tsx";
import { ErrorNotice, Notice } from "../ui.tsx";

export function LoginPage() {
  const { api, session } = useSession();
  const [params] = useSearchParams();
  const [client, setClient] = useState<PublicClient | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const rejection = params.get("error");
  const clientId = params.get("client_id");
  const signed = params.has("sig") ? params.toString() : undefined;
  const next = safeNext(params.get("next"));

  useEffect(() => {
    if (!clientId) return;
    api.publicClient(clientId, signed).then(setClient, () => setClient(undefined));
  }, [api, clientId, signed]);

  // Already signed in and no OAuth continuation: nothing to do here.
  useEffect(() => {
    if (session && !signed && !rejection) location.replace(next);
  }, [session, signed, rejection, next]);

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api.signInWithGithub(next, signed);
      location.href = url;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const clientName = client?.client_name ?? (clientId ? `client ${clientId}` : undefined);

  return (
    <div className="centered">
      <div className="card">
        <p className="eyebrow">herkules</p>
        <h1>{clientName ? "Sign in to continue" : "Sign in"}</h1>
        <p className="lede">
          {clientName
            ? `${clientName} is asking for access. Sign in with GitHub; you will choose what it may reach next.`
            : "Team members sign in with GitHub. Membership of the team's organization, or a place on the allowlist, is checked at every sign-in."}
        </p>
        {rejection ? (
          <Notice kind="error" title="Sign-in refused">
            {loginErrorMessage(rejection, params.get("error_description"))}
          </Notice>
        ) : null}
        <ErrorNotice error={error} />
        <div className="actions">
          <button className="btn primary" onClick={start} disabled={busy}>
            {busy ? "Opening GitHub…" : "Continue with GitHub"}
          </button>
        </div>
      </div>
    </div>
  );
}
