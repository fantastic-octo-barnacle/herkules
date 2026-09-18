/**
 * Who is signed in, one query shared by every route. `refresh()` after
 * sign-out. The guards live in routes.tsx: `beforeLoad` redirects to /login
 * (keeping the intended path); the admin layout renders a plain refusal.
 */
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import type { Api, Session } from "./api.ts";
import { Loading } from "./layout.tsx";

interface SessionState {
  readonly api: Api;
  readonly session: Session | null | undefined; // undefined: not loaded yet
  readonly isAdmin: boolean;
  readonly refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | undefined>(undefined);
export const SESSION_KEY = ["session"] as const;

/** The one session query, shared by the provider and the route guard. */
export const sessionQuery = (api: Api) =>
  queryOptions({
    queryKey: SESSION_KEY,
    queryFn: (): Promise<Session | null> => api.session().catch(() => null),
    staleTime: Infinity,
  });

export function SessionProvider({ api, children }: { api: Api; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery(api));
  const value = useMemo<SessionState>(
    () => ({
      api,
      session,
      isAdmin: session?.user.role === "admin",
      refresh: () => queryClient.invalidateQueries({ queryKey: SESSION_KEY }),
    }),
    [api, session, queryClient],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** Only same-origin paths are honoured as `next`, so a crafted link cannot bounce a login elsewhere. */
export function safeNext(raw: string | null): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    raw.split("").some((char) => char.charCodeAt(0) <= 32)
  )
    return "/";
  return raw;
}

/** A full navigation (the target may be outside the SPA), issued once after render. */
export function HardRedirect({ to }: { to: string }) {
  useEffect(() => {
    location.replace(to);
  }, [to]);
  return <Loading label="Redirecting" />;
}
