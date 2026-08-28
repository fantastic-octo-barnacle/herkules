/**
 * /dev-token — a real authorization-code + PKCE run against the first-party
 * public client, so what you paste into curl is exactly what an IDE gets:
 * a 15-minute JWT for one audience. /dev-token/callback finishes it.
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";

import type { Registry } from "../api.ts";
import {
  beginDevToken,
  decodeJwtPayload,
  finishDevToken,
  type CallbackOutcome,
} from "../devtoken.ts";
import { resourceName } from "../format.ts";
import { useSession } from "../session.tsx";
import { ErrorNotice, Notice, Spinner } from "../ui.tsx";

export function DevTokenPage() {
  const { api } = useSession();
  const [registry, setRegistry] = useState<Registry | undefined>();
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    api.registry().then((r) => {
      setRegistry(r);
      setAudience(r.resources[0]?.audience ?? "");
    }, setError);
  }, [api]);

  async function start() {
    if (!registry) return;
    setBusy(true);
    try {
      location.href = await beginDevToken(sessionStorage, {
        origin: location.origin,
        clientId: registry.devTokenClientId,
        audience,
      });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <p className="eyebrow">Developer</p>
      <h1>Dev token</h1>
      <p className="lede">
        Mint a 15-minute access token for one service, issued the same way an IDE gets one, for curl
        and scripts. It cannot be refreshed; come back for another.
      </p>
      <ErrorNotice error={error} />
      {!registry ? (
        <Spinner />
      ) : (
        <>
          <div className="choices" role="radiogroup" aria-label="Audience">
            {registry.resources.map((r) => (
              <label key={r.audience} className="choice">
                <input
                  type="radio"
                  name="audience"
                  value={r.audience}
                  checked={audience === r.audience}
                  onChange={() => setAudience(r.audience)}
                />
                <span>
                  <span>{r.title}</span>
                  <span className="sub">
                    <br />
                    <code>{r.audience}</code>
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="btn primary" onClick={start} disabled={busy || !audience}>
              {busy ? "Redirecting…" : `Mint token for ${resourceName(audience)}`}
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function DevTokenCallbackPage() {
  const { api } = useSession();
  const location_ = useLocation();
  const [outcome, setOutcome] = useState<CallbackOutcome | undefined>();
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    finishDevToken(sessionStorage, api, {
      origin: location.origin,
      search: location_.search,
    }).then(setOutcome, setError);
  }, [api, location_.search]);

  if (error) return <ErrorNotice error={error} />;
  if (!outcome) return <Spinner label="Exchanging the code" />;
  if (!outcome.ok)
    return (
      <>
        <h1>No token</h1>
        <Notice kind="error" title={outcome.error}>
          {outcome.description}
        </Notice>
        <Link to="/dev-token">Start again</Link>
      </>
    );

  const token = outcome.token.access_token;
  const claims = decodeJwtPayload(token) ?? {};
  const exp = typeof claims.exp === "number" ? new Date(claims.exp * 1000) : undefined;
  const curl = `curl -H 'Authorization: Bearer ${token}' ${outcome.audience}`;

  return (
    <>
      <p className="eyebrow">Developer</p>
      <h1>Token for {resourceName(outcome.audience)}</h1>
      <p className="lede">
        Valid until {exp ? exp.toLocaleTimeString() : "it expires"}. Treat it like a password; it is
        not stored anywhere but this page.
      </p>
      <pre className="token">{token}</pre>
      <div className="actions">
        <button
          className="btn primary"
          onClick={() =>
            navigator.clipboard.writeText(token).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy token"}
        </button>
        <button className="btn" onClick={() => navigator.clipboard.writeText(curl)}>
          Copy curl
        </button>
        <span className="spacer" />
        <Link className="btn" to="/dev-token">
          Mint another
        </Link>
      </div>
      <h2>Claims</h2>
      <dl className="claims">
        {Object.entries(claims).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
