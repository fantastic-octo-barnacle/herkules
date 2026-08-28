/**
 * /dev-token — a real authorization-code + PKCE run against the first-party
 * public client, so what you paste into curl is exactly what an IDE gets:
 * a 15-minute JWT for one audience. /dev-token/callback finishes it.
 */
import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router";

import { beginDevToken, decodeJwtPayload, finishDevToken } from "../devtoken.ts";
import { resourceName } from "../format.ts";
import { Actions, Eyebrow, Lede, Loading, PageTitle, SectionTitle } from "../layout.tsx";
import { ErrorNotice, Notice } from "../notices.tsx";
import { useSession } from "../session.tsx";

export function DevTokenPage() {
  const { api } = useSession();
  const registry = useQuery({ queryKey: ["registry"], queryFn: () => api.registry() });
  const [chosen, setChosen] = useState<string | undefined>();
  const audience = chosen ?? registry.data?.resources[0]?.audience ?? "";
  const start = useMutation({
    mutationFn: () =>
      beginDevToken(sessionStorage, {
        origin: location.origin,
        clientId: registry.data!.devTokenClientId,
        audience,
      }),
    onSuccess: (url) => {
      location.href = url;
    },
  });
  const busy = start.isPending || start.isSuccess;

  return (
    <>
      <Eyebrow>Developer</Eyebrow>
      <PageTitle>Dev token</PageTitle>
      <Lede>
        Mint a 15-minute access token for one service, issued the same way an IDE gets one, for curl
        and scripts. It cannot be refreshed; come back for another.
      </Lede>
      <ErrorNotice error={registry.error ?? start.error} />
      {!registry.data ? (
        registry.isError ? null : (
          <Loading />
        )
      ) : (
        <>
          <div className="my-4 grid gap-2" role="radiogroup" aria-label="Audience">
            {registry.data.resources.map((r) => (
              <label
                key={r.audience}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-surface px-4 py-3 has-checked:border-accent"
              >
                <input
                  type="radio"
                  name="audience"
                  value={r.audience}
                  className="mt-1.5 accent-accent"
                  checked={audience === r.audience}
                  onChange={() => setChosen(r.audience)}
                />
                <span>
                  <span>{r.title}</span>
                  <span className="block text-[0.85rem] text-muted-foreground">
                    <code>{r.audience}</code>
                  </span>
                </span>
              </label>
            ))}
          </div>
          <Actions>
            <Button onClick={() => start.mutate()} disabled={busy || !audience}>
              {busy ? "Redirecting…" : `Mint token for ${resourceName(audience)}`}
            </Button>
          </Actions>
        </>
      )}
    </>
  );
}

export function DevTokenCallbackPage() {
  const { api } = useSession();
  const { search } = useLocation();
  const [copied, setCopied] = useState(false);
  // The code is single-use: one query per callback URL, never refetched.
  const exchange = useQuery({
    queryKey: ["dev-token", search],
    queryFn: () => finishDevToken(sessionStorage, api, { origin: location.origin, search }),
    staleTime: Infinity,
  });

  if (exchange.error) return <ErrorNotice error={exchange.error} />;
  const outcome = exchange.data;
  if (!outcome) return <Loading label="Exchanging the code" />;
  if (!outcome.ok)
    return (
      <>
        <PageTitle>No token</PageTitle>
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
      <Eyebrow>Developer</Eyebrow>
      <PageTitle>Token for {resourceName(outcome.audience)}</PageTitle>
      <Lede>
        Valid until {exp ? exp.toLocaleTimeString() : "it expires"}. Treat it like a password; it is
        not stored anywhere but this page.
      </Lede>
      <pre className="m-0 rounded-md border border-line bg-surface-2 p-3.5 font-mono text-[0.8rem] whitespace-pre-wrap wrap-anywhere">
        {token}
      </pre>
      <Actions>
        <Button
          onClick={() =>
            navigator.clipboard.writeText(token).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy token"}
        </Button>
        <Button variant="outline" onClick={() => navigator.clipboard.writeText(curl)}>
          Copy curl
        </Button>
        <span className="flex-1" />
        <Button variant="outline" asChild>
          <Link to="/dev-token">Mint another</Link>
        </Button>
      </Actions>
      <SectionTitle>Claims</SectionTitle>
      <dl className="my-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[0.9rem]">
        {Object.entries(claims).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-muted-foreground">{k}</dt>
            <dd className="m-0 wrap-anywhere">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
