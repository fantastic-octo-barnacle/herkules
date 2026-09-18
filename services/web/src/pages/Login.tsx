/**
 * /login — plain, or with Better Auth's signed OAuth query when an IDE's
 * authorization needs a session first. Rejections from the gate arrive as
 * /login?error=…&error_description=… and are shown in the service's words.
 */
import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";

import { loginErrorMessage } from "../format.ts";
import { Actions, CenteredCard, Eyebrow, Lede, PageTitle } from "../layout.tsx";
import { ErrorNotice, Notice } from "../notices.tsx";
import { readOAuthPageQuery } from "../oauth-query.ts";
import { HardRedirect, safeNext, useSession } from "../session.tsx";

export function LoginPage() {
  const { api, session } = useSession();
  const { params, continuation } = readOAuthPageQuery();

  const rejection = params.get("error");
  const clientId = new URLSearchParams(continuation).get("client_id");
  const next = safeNext(params.get("next"));

  const client = useQuery({
    queryKey: ["public-client", clientId, continuation],
    queryFn: () => api.publicClient(clientId!, continuation).catch(() => null),
    enabled: !!clientId,
  });
  const options = useQuery({ queryKey: ["login-options"], queryFn: () => api.loginOptions() });
  const start = useMutation({
    mutationFn: (provider: "github" | "feishu") =>
      provider === "github"
        ? api.signInWithGithub(next, continuation)
        : api.signInWithFeishu(`/connect-github?next=${encodeURIComponent(next)}`, continuation),
    onSuccess: ({ url }) => {
      location.href = url;
    },
  });

  // Already signed in and no OAuth continuation: nothing to do here.
  if (session && !continuation && !rejection) return <HardRedirect to={next} />;

  const clientName = client.data?.client_name ?? (clientId ? `client ${clientId}` : undefined);
  return (
    <CenteredCard>
      <Eyebrow>herkules</Eyebrow>
      <PageTitle>{clientName ? "Sign in to continue" : "Sign in"}</PageTitle>
      <Lede>
        {clientName
          ? `${clientName} is asking for access. Sign in; you will choose what it may reach next.`
          : options.data?.feishu
            ? "Sign in with Feishu or GitHub. Your provider must supply a real email, and your account must pass its team or allowlist check. You can connect GitHub after Feishu sign-in."
            : "Sign in with GitHub using your team organization membership or allowlist entry."}
      </Lede>
      {params.get("merged") === "1" ? (
        <Notice title="Accounts merged">
          Sign in with either provider to continue using your combined account.
        </Notice>
      ) : null}
      {rejection ? (
        <Notice kind="error" title="Sign-in refused">
          {loginErrorMessage(rejection, params.get("error_description"))}
        </Notice>
      ) : null}
      <ErrorNotice error={start.error ?? options.error} />
      <Actions>
        {options.data?.feishu ? (
          <Button
            onClick={() => start.mutate("feishu")}
            disabled={start.isPending || start.isSuccess}
          >
            {start.variables === "feishu" && (start.isPending || start.isSuccess)
              ? "Opening Feishu…"
              : "Continue with Feishu"}
          </Button>
        ) : null}
        <Button
          variant={options.data?.feishu ? "outline" : "default"}
          onClick={() => start.mutate("github")}
          disabled={!options.data || start.isPending || start.isSuccess}
        >
          {start.variables === "github" && (start.isPending || start.isSuccess)
            ? "Opening GitHub…"
            : "Continue with GitHub"}
        </Button>
      </Actions>
    </CenteredCard>
  );
}
