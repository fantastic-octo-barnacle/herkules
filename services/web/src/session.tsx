/**
 * Who is signed in, once per page load, shared by every route. `refresh()`
 * after sign-out. Guards redirect to /login (keeping the intended path) or
 * render a plain refusal for non-admins.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

import type { Api, Session } from "./api.ts";
import { createApi } from "./api.ts";
import { Notice, Spinner } from "./ui.tsx";

interface SessionState {
  readonly api: Api;
  readonly session: Session | null | undefined; // undefined: not loaded yet
  readonly isAdmin: boolean;
  readonly refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ api: given, children }: { api?: Api; children: ReactNode }) {
  // One client for the provider's life: a default parameter would be rebuilt every render and re-fire every effect keyed on `api`.
  const [api] = useState(() => given ?? createApi());
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    setSession(await api.session().catch(() => null));
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const value = useMemo<SessionState>(
    () => ({ api, session, isAdmin: session?.user.role === "admin", refresh }),
    [api, session, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** Signed-in only. Unauthenticated visitors go to /login?next=<here>. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const location = useLocation();
  if (session === undefined) return <Spinner />;
  if (session === null) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, isAdmin } = useSession();
  if (session === undefined) return <Spinner />;
  if (!isAdmin)
    return (
      <Notice kind="warn" title="Admins only">
        This page needs the admin role. Ask an existing admin to promote you.
      </Notice>
    );
  return <>{children}</>;
}

/** Only same-origin paths are honoured as `next`, so a crafted link cannot bounce a login elsewhere. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
