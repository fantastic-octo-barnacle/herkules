import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";

import { AdminAllowlistPage } from "./pages/AdminAllowlist.tsx";
import { AdminAuditPage } from "./pages/AdminAudit.tsx";
import { AdminUsersPage } from "./pages/AdminUsers.tsx";
import { ConsentPage } from "./pages/Consent.tsx";
import { DevTokenCallbackPage, DevTokenPage } from "./pages/DevToken.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { RequireAdmin, RequireAuth, SessionProvider, useSession } from "./session.tsx";
import { Avatar } from "./ui.tsx";
import "./styles.css";

function Shell() {
  const { api, session, isAdmin, refresh } = useSession();
  async function signOut() {
    await api.signOut();
    await refresh();
    location.assign("/login");
  }
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="wordmark">
          herkules
        </NavLink>
        <span className="issuer">{location.origin}/auth</span>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Settings
          </NavLink>
          <NavLink to="/dev-token">Dev token</NavLink>
          {isAdmin ? (
            <>
              <NavLink to="/admin" end>
                Members
              </NavLink>
              <NavLink to="/admin/allowlist">Allowlist</NavLink>
              <NavLink to="/admin/audit">Audit</NavLink>
            </>
          ) : null}
          {session ? (
            <span className="me">
              <Avatar src={session.user.image} name={session.user.name} />
              <button className="btn sm" onClick={signOut}>
                Sign out
              </button>
            </span>
          ) : null}
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function App() {
  return (
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
            <Route path="*" element={<p className="empty">There is nothing at this address.</p>} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
