/**
 * The URL contract of the SPA in one file. Guards are routing, not rendering:
 * the `authed` layout's `beforeLoad` settles the session query and redirects
 * to /login?next=<here> when nobody is signed in; the admin layout renders a
 * refusal for non-admins.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import type { Api } from "./api.ts";
import { Empty } from "./layout.tsx";
import { Notice } from "./notices.tsx";
import { AdminAllowlistPage } from "./pages/AdminAllowlist.tsx";
import { AdminAuditPage } from "./pages/AdminAudit.tsx";
import { AdminUsersPage } from "./pages/AdminUsers.tsx";
import { ConsentPage } from "./pages/Consent.tsx";
import { DevTokenCallbackPage, DevTokenPage } from "./pages/DevToken.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { sessionQuery, useSession } from "./session.tsx";
import { Shell } from "./shell.tsx";

export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly api: Api;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});
const parent = () => rootRoute;

export const loginRoute = createRoute({
  getParentRoute: parent,
  path: "/login",
  component: LoginPage,
});
export const consentRoute = createRoute({
  getParentRoute: parent,
  path: "/consent",
  component: ConsentPage,
});

/** Signed-in only. Unauthenticated visitors go to /login?next=<here>. */
export const authedRoute = createRoute({
  getParentRoute: parent,
  id: "authed",
  beforeLoad: async ({ context: { queryClient, api }, location }) => {
    const session = await queryClient.ensureQueryData(sessionQuery(api));
    if (!session)
      throw redirect({
        to: "/login",
        search: { next: location.pathname + location.searchStr },
        replace: true,
      });
  },
  component: Shell,
});
const authed = () => authedRoute;

export const settingsRoute = createRoute({
  getParentRoute: authed,
  path: "/",
  component: SettingsPage,
});
export const settingsAliasRoute = createRoute({
  getParentRoute: authed,
  path: "/settings",
  component: SettingsPage,
});
export const devTokenRoute = createRoute({
  getParentRoute: authed,
  path: "/dev-token",
  component: DevTokenPage,
});
export const devTokenCallbackRoute = createRoute({
  getParentRoute: authed,
  path: "/dev-token/callback",
  component: DevTokenCallbackPage,
});

function AdminLayout() {
  const { isAdmin } = useSession();
  if (!isAdmin)
    return (
      <Notice kind="warn" title="Admins only">
        This page needs the admin role. Ask an existing admin to promote you.
      </Notice>
    );
  return <Outlet />;
}
export const adminRoute = createRoute({
  getParentRoute: authed,
  path: "/admin",
  component: AdminLayout,
});
const admin = () => adminRoute;
export const adminUsersRoute = createRoute({
  getParentRoute: admin,
  path: "/",
  component: AdminUsersPage,
});
export const adminAllowlistRoute = createRoute({
  getParentRoute: admin,
  path: "/allowlist",
  component: AdminAllowlistPage,
});
export const adminAuditRoute = createRoute({
  getParentRoute: admin,
  path: "/audit",
  component: AdminAuditPage,
});

/** Anything else, still behind the sign-in and inside the shell. */
export const catchAllRoute = createRoute({
  getParentRoute: authed,
  path: "$",
  component: () => <Empty>There is nothing at this address.</Empty>,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  consentRoute,
  authedRoute.addChildren([
    settingsRoute,
    settingsAliasRoute,
    devTokenRoute,
    devTokenCallbackRoute,
    adminRoute.addChildren([adminUsersRoute, adminAllowlistRoute, adminAuditRoute]),
    catchAllRoute,
  ]),
]);

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 300,
    defaultPendingMinMs: 300,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
