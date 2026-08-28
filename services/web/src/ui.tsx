import type { ReactNode } from "react";

import { ApiError } from "./api.ts";

export function Notice({
  kind = "info",
  title,
  children,
}: {
  kind?: "info" | "error" | "warn" | "ok";
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`notice ${kind === "info" ? "" : kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
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

export function Avatar({
  src,
  name,
  large,
}: {
  src: string | null;
  name: string;
  large?: boolean;
}) {
  return src ? (
    <img className={large ? "avatar lg" : "avatar"} src={src} alt="" title={name} />
  ) : (
    <span className={large ? "avatar lg" : "avatar"} aria-hidden="true" />
  );
}

export function Badge({ kind, children }: { kind?: "admin" | "off"; children: ReactNode }) {
  return <span className={`badge ${kind ?? ""}`}>{children}</span>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <p className="empty">{label}…</p>;
}
