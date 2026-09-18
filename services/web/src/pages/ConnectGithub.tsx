import { Button } from "@herkules/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { IdentityMerge, MergeReauthentication } from "../identity-merge.tsx";
import { ConfirmDialog } from "../confirm.tsx";
import { Actions, Lede, PageTitle } from "../layout.tsx";
import { ErrorNotice, Notice } from "../notices.tsx";
import { loginErrorMessage } from "../format.ts";
import { readOAuthPageQuery } from "../oauth-query.ts";
import { safeNext, useSession } from "../session.tsx";

/** Optional post-login step. Keep Better Auth's signed continuation intact across linking. */
export function ConnectGithubPage() {
  const { api, session } = useSession();
  const { params, continuation } = readOAuthPageQuery();
  const next = safeNext(params.get("next"));
  const callback = `/connect-github?${continuation ?? new URLSearchParams({ next }).toString()}`;
  const link = useMutation({
    mutationFn: () => api.linkIdentity("github", callback),
    onSuccess: ({ url }) => {
      location.href = url;
    },
  });
  const proceed = useMutation({
    mutationFn: async () => {
      await api.finishIdentitySetup();
      if (!continuation) return next;
      const result = await api.continueLogin(continuation);
      const target = result.url ?? result.redirect_uri;
      if (!target) throw new Error("Could not continue authorization. Please retry.");
      return target;
    },
    onSuccess: (url) => {
      location.href = url;
    },
  });
  const connected = !!session?.user.githubId;
  const error = params.get("error");
  return (
    <>
      <PageTitle>{connected ? "GitHub connected" : "Connect GitHub?"}</PageTitle>
      <Lede>
        {connected
          ? "Your GitHub account is connected to this Herkules account."
          : "You’re signed in with Feishu. You can connect GitHub now or later in settings."}
      </Lede>
      {error === "merge_available" ? (
        <IdentityMerge returnTo={callback} />
      ) : error ? (
        <Notice kind="error" title="Connection failed">
          {loginErrorMessage(error, params.get("error_description"))}
        </Notice>
      ) : null}
      {error === "merge_reauthentication_required" ? (
        <MergeReauthentication returnTo={callback} />
      ) : null}
      <ErrorNotice error={link.error ?? proceed.error} />
      <Actions>
        {!connected && error !== "merge_available" ? (
          <ConfirmDialog
            trigger={<Button disabled={link.isPending || proceed.isPending}>Connect GitHub</Button>}
            title="Connect GitHub?"
            description="This attaches your GitHub identity to this Herkules account. Removing an identity requires administrator assistance."
            confirmLabel="Continue to GitHub"
            onConfirm={() => link.mutate()}
          />
        ) : null}
        <Button
          variant={connected ? "default" : "outline"}
          onClick={() => proceed.mutate()}
          disabled={link.isPending || proceed.isPending}
        >
          {connected ? "Continue" : "Skip for now"}
        </Button>
      </Actions>
    </>
  );
}
