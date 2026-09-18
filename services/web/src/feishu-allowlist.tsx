import { Button } from "@herkules/ui/components/button";
import { Input } from "@herkules/ui/components/input";
import { Label } from "@herkules/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "./confirm.tsx";
import type { FeishuAllowlistEntry } from "./api.ts";
import { Lede, SectionTitle, Empty } from "./layout.tsx";
import { ErrorNotice } from "./notices.tsx";
import { useSession } from "./session.tsx";

const KEY = ["admin", "feishu-allowlist"] as const;
export function FeishuAllowlist() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [tenant, setTenant] = useState("");
  const [openId, setOpenId] = useState("");
  const [note, setNote] = useState("");
  const list = useQuery({ queryKey: KEY, queryFn: () => api.admin.feishuAllowlist() });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: () =>
      api.admin.feishuAllowlistAdd(tenant.trim(), openId.trim(), note.trim() || undefined),
    onSuccess: () => {
      setTenant("");
      setOpenId("");
      setNote("");
      return invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (entry: FeishuAllowlistEntry) =>
      api.admin.feishuAllowlistRemove(entry.tenantKey, entry.openId),
    onSuccess: invalidate,
  });
  const busy = add.isPending || remove.isPending;
  return (
    <>
      <SectionTitle>External Feishu users</SectionTitle>
      <Lede>
        Allow an external identity from another tenant. Use the tenant key and open ID from this
        Feishu app, not an email or a user ID from another app. The user still needs app access and
        a readable Feishu email.
      </Lede>
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="feishu-tenant">Tenant key</Label>
          <Input
            id="feishu-tenant"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            required
            pattern="[A-Za-z0-9_-]{1,128}"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="feishu-open-id">Open ID</Label>
          <Input
            id="feishu-open-id"
            value={openId}
            onChange={(e) => setOpenId(e.target.value)}
            required
            pattern="[A-Za-z0-9_-]{1,128}"
            placeholder="ou_…"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="feishu-note">Note (optional)</Label>
          <Input
            id="feishu-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </div>
        <Button type="submit" disabled={busy || !tenant.trim() || !openId.trim()}>
          Allow external user
        </Button>
      </form>
      <ErrorNotice error={list.error ?? add.error ?? remove.error} />
      {list.data?.length === 0 ? <Empty>No external Feishu users are allowlisted.</Empty> : null}
      {list.data?.map((entry) => (
        <div
          key={`${entry.tenantKey}:${entry.openId}`}
          className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
        >
          <div>
            <code>
              {entry.tenantKey} / {entry.openId}
            </code>
            {entry.note ? <p>{entry.note}</p> : null}
          </div>
          <ConfirmDialog
            trigger={
              <Button variant="destructive" size="sm" disabled={busy}>
                Remove
              </Button>
            }
            title="Remove this external Feishu user?"
            description="Their next login and token grant will be refused unless they belong to the team tenant. Existing browser sessions remain until expiry; disable their account to revoke sessions too."
            confirmLabel="Remove"
            onConfirm={() => remove.mutate(entry)}
          />
        </div>
      ))}
    </>
  );
}
