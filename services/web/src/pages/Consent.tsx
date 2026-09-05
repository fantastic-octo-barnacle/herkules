/**
 * /consent?<signed query> — the grant as a ledger line: client -> resource.
 * Better Auth sends here with the original authorize parameters signed;
 * we answer with the same query so nothing about the request is ours to trust.
 */
import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";

import { resourceName } from "../format.ts";
import { Actions, CenteredCard, Eyebrow, Lede, Loading, PageTitle } from "../layout.tsx";
import { ErrorNotice } from "../notices.tsx";
import { readOAuthPageQuery } from "../oauth-query.ts";
import { HardRedirect, useSession } from "../session.tsx";

export function ConsentPage() {
  const { api, session } = useSession();
  const { params, continuation } = readOAuthPageQuery();

  const clientId = params.get("client_id") ?? "";
  const resources = params.getAll("resource");
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const ready = !!session && !!clientId;

  const client = useQuery({
    queryKey: ["public-client", clientId],
    queryFn: () => api.publicClient(clientId).catch(() => null),
    enabled: ready,
  });
  const registry = useQuery({
    queryKey: ["registry"],
    queryFn: () => api.registry(),
    enabled: ready,
  });
  const answer = useMutation({
    mutationFn: async (accept: boolean) => {
      if (!continuation) throw new Error("The authorization request is missing its signature.");
      const r = await api.consent(accept, continuation);
      const url = r.url ?? r.redirect_uri;
      if (!url) throw new Error("The authorization server returned no redirect.");
      return url;
    },
    onSuccess: (url) => {
      location.href = url;
    },
  });

  if (session === undefined) return <Loading />;
  if (session === null)
    return <HardRedirect to={continuation ? `/login?${continuation}` : "/login"} />;
  if (!clientId || !continuation)
    return (
      <CenteredCard>
        <PageTitle>Nothing to approve</PageTitle>
        <Lede>
          This page is opened by an application asking for access. Start the connection from your
          editor or client again.
        </Lede>
      </CenteredCard>
    );

  const titleOf = (audience: string) =>
    registry.data?.resources.find((e) => e.audience === audience)?.title ?? resourceName(audience);
  const clientName = client.data?.client_name ?? `client ${clientId}`;
  const busy = answer.isPending || answer.isSuccess;

  return (
    <CenteredCard>
      <Eyebrow>Connection request</Eyebrow>
      <PageTitle>Allow {clientName}?</PageTitle>
      <div
        className="my-6 grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-y border-line py-4 [&_.name]:font-display [&_.name]:text-[1.2rem] [&_.name]:wrap-anywhere [&_.sub]:font-mono [&_.sub]:text-[0.85rem] [&_.sub]:text-muted-foreground [&_.sub]:wrap-anywhere"
        aria-label="What will be granted"
      >
        <div className="min-w-0">
          <div className="name">{clientName}</div>
          <div className="sub">{clientId}</div>
        </div>
        <div className="font-display text-2xl text-accent" aria-hidden="true">
          →
        </div>
        <div className="min-w-0 text-right">
          {resources.length === 0 ? (
            <div className="name">your account</div>
          ) : (
            resources.map((r) => (
              <div key={r}>
                <div className="name">{titleOf(r)}</div>
                <div className="sub">{r}</div>
              </div>
            ))
          )}
        </div>
      </div>
      <Lede>
        It will act as <strong>{session.user.name}</strong>
        {scopes.includes("offline_access") ? " and stay connected until you disconnect it" : ""}.
        You can disconnect it any time from Settings.
      </Lede>
      <ErrorNotice error={answer.error} />
      <Actions>
        <Button variant="outline" onClick={() => answer.mutate(false)} disabled={busy}>
          {answer.variables === false && busy ? "Denying…" : "Deny"}
        </Button>
        <span className="flex-1" />
        <Button onClick={() => answer.mutate(true)} disabled={busy}>
          {answer.variables === true && busy ? "Allowing…" : "Allow"}
        </Button>
      </Actions>
    </CenteredCard>
  );
}
