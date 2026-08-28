import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Button } from "@herkules/ui/components/button";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";

import { Empty } from "./layout.tsx";
import { AdminAllowlistPage } from "./pages/AdminAllowlist.tsx";
import { AdminAuditPage } from "./pages/AdminAudit.tsx";
import { AdminUsersPage } from "./pages/AdminUsers.tsx";
import { ConsentPage } from "./pages/Consent.tsx";
import { DevTokenCallbackPage, DevTokenPage } from "./pages/DevToken.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { RequireAdmin, RequireAuth, SessionProvider, useSession } from "./session.tsx";
import "@herkules/ui/theme.css";

const navLink = ({ isActive }: { isActive: boolean }) =>
  `border-b-2 py-0.5 text-ink-2 hover:text-ink hover:no-underline ${isActive ? "border-accent text-ink" : "border-transparent"}`;

function Shell() {
  const { api, session, isAdmin, refresh } = useSession();
  async function signOut() {
    await api.signOut();
    await refresh();
    location.assign("/login");
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-baseline gap-6 border-b border-line bg-surface px-6 py-3.5">
        <NavLink
          to="/"
          className="font-display text-2xl tracking-[0.01em] text-ink hover:no-underline"
        >
          herkules
        </NavLink>
        <span className="font-mono text-xs text-muted-foreground">{location.origin}/auth</span>
        <nav className="ml-auto flex flex-wrap items-baseline gap-4" aria-label="Main">
          <NavLink to="/" end className={navLink}>
            Settings
          </NavLink>
          <NavLink to="/dev-token" className={navLink}>
            Dev token
          </NavLink>
          {isAdmin ? (
            <>
              <NavLink to="/admin" end className={navLink}>
                Members
              </NavLink>
              <NavLink to="/admin/allowlist" className={navLink}>
                Allowlist
              </NavLink>
              <NavLink to="/admin/audit" className={navLink}>
                Audit
              </NavLink>
            </>
          ) : null}
          {session ? (
            <span className="inline-flex items-center gap-2 text-ink-2">
              <Avatar size="sm">
                <AvatarImage src={session.user.image ?? undefined} alt="" />
                <AvatarFallback />
              </Avatar>
              <Button variant="outline" size="sm" onClick={signOut}>
                Sign out
              </Button>
            </span>
          ) : null}
        </nav>
      </header>
      <main className="mx-auto w-[min(100%-3rem,var(--measure))] flex-1 pt-8 pb-16">
        <Outlet />
      </main>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/consent" element={<ConsentPage />} />
            <Route
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            >
              <Route index element={<SettingsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="dev-token" element={<DevTokenPage />} />
              <Route path="dev-token/callback" element={<DevTokenCallbackPage />} />
              <Route
                path="admin"
                element={
                  <RequireAdmin>
                    <Outlet />
                  </RequireAdmin>
                }
              >
                <Route index element={<AdminUsersPage />} />
                <Route path="allowlist" element={<AdminAllowlistPage />} />
                <Route path="audit" element={<AdminAuditPage />} />
              </Route>
              <Route path="*" element={<Empty>There is nothing at this address.</Empty>} />
            </Route>
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
