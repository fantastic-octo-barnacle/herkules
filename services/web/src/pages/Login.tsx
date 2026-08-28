/**
 * /login — plain, or with Better Auth's signed OAuth query when an IDE's
 * authorization needs a session first. Rejections from the gate arrive as
 * /login?error=…&error_description=… and are shown in the service's words.
 */
import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { loginErrorMessage } from "../format.ts";
import { Actions, CenteredCard, Eyebrow, Lede, PageTitle } from "../layout.tsx";
import { ErrorNotice, Notice } from "../notices.tsx";
import { HardRedirect, safeNext, useSession } from "../session.tsx";

export function LoginPage() {
  const { api, session } = useSession();
  const [params] = useSearchParams();

  const rejection = params.get("error");
  const clientId = params.get("client_id");
  const signed = params.has("sig") ? params.toString() : undefined;
  const next = safeNext(params.get("next"));

  const client = useQuery({
    queryKey: ["public-client", clientId, signed],
    queryFn: () => api.publicClient(clientId!, signed).catch(() => null),
    enabled: !!clientId,
  });
  const start = useMutation({
    mutationFn: () => api.signInWithGithub(next, signed),
    onSuccess: ({ url }) => {
      location.href = url;
    },
  });

  // Already signed in and no OAuth continuation: nothing to do here.
  if (session && !signed && !rejection) return <HardRedirect to={next} />;

  const clientName = client.data?.client_name ?? (clientId ? `client ${clientId}` : undefined);
  return (
    <CenteredCard>
      <Eyebrow>herkules</Eyebrow>
      <PageTitle>{clientName ? "Sign in to continue" : "Sign in"}</PageTitle>
      <Lede>
        {clientName
          ? `${clientName} is asking for access. Sign in with GitHub; you will choose what it may reach next.`
          : "Team members sign in with GitHub. Membership of the team's organization, or a place on the allowlist, is checked at every sign-in."}
      </Lede>
      {rejection ? (
        <Notice kind="error" title="Sign-in refused">
          {loginErrorMessage(rejection, params.get("error_description"))}
        </Notice>
      ) : null}
      <ErrorNotice error={start.error} />
      <Actions>
        <Button onClick={() => start.mutate()} disabled={start.isPending || start.isSuccess}>
          {start.isPending || start.isSuccess ? "Opening GitHub…" : "Continue with GitHub"}
        </Button>
      </Actions>
    </CenteredCard>
  );
}
