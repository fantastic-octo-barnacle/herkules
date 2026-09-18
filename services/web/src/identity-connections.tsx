import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IdentityMerge, MergeReauthentication } from "./identity-merge.tsx";
import { ConfirmDialog } from "./confirm.tsx";
import { Lede, SectionTitle } from "./layout.tsx";
import { ErrorNotice, Notice } from "./notices.tsx";
import { loginErrorMessage } from "./format.ts";
import { useSession } from "./session.tsx";

export function IdentityConnections() {
  const { api, session } = useSession();
  const options = useQuery({ queryKey: ["login-options"], queryFn: () => api.loginOptions() });
  const link = useMutation({
    mutationFn: (provider: "github" | "feishu") => api.linkIdentity(provider, "/settings"),
    onSuccess: ({ url }) => {
      location.href = url;
    },
  });
  const error = new URLSearchParams(location.search).get("error");
  const u = session?.user;
  return (
    <>
      <SectionTitle>Connected identities</SectionTitle>
      {error === "merge_available" ? (
        <IdentityMerge returnTo="/settings" />
      ) : error ? (
        <Notice kind="error" title="Connection failed">
          {loginErrorMessage(error, null)}
        </Notice>
      ) : null}
      {error === "merge_reauthentication_required" ? (
        <MergeReauthentication returnTo={"/settings"} />
      ) : null}
      <ErrorNotice error={link.error ?? options.error} />
      <Lede>
        {u?.githubId
          ? `GitHub connected${u.githubLogin ? `: ${u.githubLogin}` : ""}.`
          : "GitHub connection is optional."}
      </Lede>
      {!u?.githubId ? (
        <ConfirmDialog
          trigger={
            <Button variant="outline" disabled={link.isPending}>
              Connect GitHub
            </Button>
          }
          title="Connect GitHub?"
          description="This attaches your GitHub identity to this Herkules account. Removing an identity requires administrator assistance."
          confirmLabel="Continue to GitHub"
          onConfirm={() => link.mutate("github")}
        />
      ) : null}
      {u?.feishuOpenId ? (
        <Lede>
          Feishu connected. Each sign-in provider checks its own email and admission rules. Tenant:{" "}
          <code>{u.feishuTenantKey}</code>; open ID: <code>{u.feishuOpenId}</code>.
        </Lede>
      ) : options.data?.feishu ? (
        <>
          <Lede>
            Connect Feishu as another sign-in option while keeping this account, its permissions and
            application data. Feishu requires a readable email.
          </Lede>
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={link.isPending}>
                Connect Feishu
              </Button>
            }
            title="Connect Feishu to this account?"
            description="Your account and data stay the same. Feishu becomes another sign-in option with its own email and admission checks. Removing an identity requires administrator assistance."
            confirmLabel="Continue to Feishu"
            onConfirm={() => link.mutate("feishu")}
          />
        </>
      ) : null}
    </>
  );
}
