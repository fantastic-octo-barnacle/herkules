import { Button } from "@herkules/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import { ConfirmDialog } from "./confirm.tsx";
import { Actions, Lede } from "./layout.tsx";
import { ErrorNotice, Notice } from "./notices.tsx";
import { readOAuthPageQuery } from "./oauth-query.ts";
import { useSession } from "./session.tsx";

/** Shown only after OAuth has proved ownership of an already-connected identity. */
export function IdentityMerge({ returnTo }: { readonly returnTo: string }) {
  const { api, session } = useSession();
  const { continuation } = readOAuthPageQuery();
  const preview = useQuery({
    queryKey: ["identity-merge", session?.session.id],
    queryFn: () => api.previewIdentityMerge(),
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: (id: string) => api.confirmIdentityMerge(id),
    onSuccess: () => {
      // Preserve the signed authorization request across the required new login.
      const query = new URLSearchParams({ next: returnTo, merged: "1" });
      location.href = `/login?${query}${continuation ? `&${continuation}` : ""}`;
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelIdentityMerge(),
    onSuccess: () => {
      location.href = returnTo;
    },
  });
  const retry = useMutation({
    mutationFn: () => api.linkIdentity(session?.user.githubId ? "feishu" : "github", returnTo),
    onSuccess: ({ url }) => {
      location.href = url;
    },
  });
  const failure = preview.error ?? confirm.error;
  const needsLogin =
    failure instanceof ApiError && failure.code === "merge_reauthentication_required";
  return (
    <Notice title="Combine your accounts?">
      <Lede>
        You already have a Herkules account with this identity. You can combine the two accounts
        after reviewing the details below.
      </Lede>
      <ErrorNotice error={failure ?? cancel.error ?? retry.error} />
      {needsLogin ? (
        <MergeReauthentication returnTo={returnTo} />
      ) : failure ? (
        <ConfirmDialog
          trigger={
            <Button variant="outline" disabled={retry.isPending}>
              Verify identities again
            </Button>
          }
          title="Connect this identity again?"
          description="You’ll authorize the provider again. An unused identity will be connected directly; an identity on another account requires a separate merge confirmation."
          confirmLabel="Continue to provider"
          onConfirm={() => retry.mutate()}
        />
      ) : null}
      {preview.data ? (
        <>
          <p>
            Feishu: <strong>{preview.data.feishuName}</strong>. GitHub:{" "}
            <strong>{preview.data.githubLogin}</strong>.
          </p>
          <p>
            Keep <strong>{preview.data.retainedAccount.name}</strong> and its application data. Both
            identities will sign in to that account. Existing administrator access is preserved.
          </p>
          <Actions>
            <ConfirmDialog
              trigger={
                <Button disabled={!!failure || confirm.isPending || cancel.isPending}>
                  Merge accounts
                </Button>
              }
              title="Merge these accounts?"
              description="The duplicate account will be retired. Both identities will use the retained account, with your Feishu profile. All Herkules sessions and refresh tokens for both accounts will be revoked; sign in again to continue. This cannot be undone here."
              confirmLabel="Merge and sign in again"
              onConfirm={() => confirm.mutate(preview.data!.id)}
            />
          </Actions>
        </>
      ) : null}
      <Button
        variant="outline"
        disabled={confirm.isPending || cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        Keep separate
      </Button>
    </Notice>
  );
}

/** A fresh source session is required before another OAuth proof can merge it. */
export function MergeReauthentication({ returnTo }: { readonly returnTo: string }) {
  const { api } = useSession();
  const { continuation } = readOAuthPageQuery();
  const signIn = useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: () => {
      location.href = `/login?next=${encodeURIComponent(returnTo)}${continuation ? `&${continuation}` : ""}`;
    },
  });
  return (
    <>
      <ErrorNotice error={signIn.error} />
      <Button variant="outline" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
        Sign in again
      </Button>
    </>
  );
}
