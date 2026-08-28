/** Inline notices over shadcn's Alert; `ErrorNotice` shows an ApiError in the service's words. */
import { Alert, AlertDescription, AlertTitle } from "@herkules/ui/components/alert";
import type { ReactNode } from "react";

import { ApiError } from "./api.ts";

const TONE = {
  info: "bg-surface-2",
  error: "border-danger/40 bg-danger-soft text-ink",
  warn: "border-warn/40 bg-warn-soft",
  ok: "border-accent/40 bg-accent-soft",
} as const;

export function Notice({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof TONE;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Alert
      className={`mb-4 border-line ${TONE[kind]}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className="text-ink">{children}</AlertDescription>
    </Alert>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? `${error.message} (${error.code})`
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Something went wrong.";
  return <Notice kind="error">{message}</Notice>;
}
