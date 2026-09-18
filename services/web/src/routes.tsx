/**
 * The URL contract of the SPA in one file. Two pathless layouts stack: `app`
 * owns the shell, which the public landing page and every signed-in screen
 * share; `authed` sits inside it and owns the guard. Guards are routing, not
 * rendering — `authed`'s `beforeLoad` settles the session query and redirects
 * to /login?next=<here> when nobody is signed in; the admin layout renders a
 * refusal for non-admins.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import type { Api } from "./api.ts";
import { Empty } from "./layout.tsx";
import { Notice } from "./notices.tsx";
import { ConsentPage } from "./pages/Consent.tsx";
import { HomePage } from "./pages/Home.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { sessionQuery, useSession } from "./session.tsx";
import { Shell } from "./shell.tsx";

/*
 * Login, consent and home stay in the entry chunk: they are where OAuth flows
 * and first visits land. Everything behind the session guard loads on demand
 * (and on hover/focus, via `defaultPreload: "intent"`).
 */
const SettingsPage = lazyRouteComponent(() => import("./pages/Settings.tsx"), "SettingsPage");
const DevTokenPage = lazyRouteComponent(() => import("./pages/DevToken.tsx"), "DevTokenPage");
const DevTokenCallbackPage = lazyRouteComponent(
  () => import("./pages/DevToken.tsx"),
  "DevTokenCallbackPage",
);
const AdminUsersPage = lazyRouteComponent(() => import("./pages/AdminUsers.tsx"), "AdminUsersPage");
const AdminAllowlistPage = lazyRouteComponent(
  () => import("./pages/AdminAllowlist.tsx"),
  "AdminAllowlistPage",
);
const AdminAuditPage = lazyRouteComponent(() => import("./pages/AdminAudit.tsx"), "AdminAuditPage");

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

/** The shell — one header for the public landing page and the signed-in screens alike. */
export const appRoute = createRoute({
  getParentRoute: parent,
  id: "app",
  component: Shell,
});
const app = () => appRoute;

/** Public. The one screen that renders with or without a session. */
export const homeRoute = createRoute({
  getParentRoute: app,
  path: "/",
  component: HomePage,
});

/** Signed-in only. Unauthenticated visitors go to /login?next=<here>. */
export const authedRoute = createRoute({
  getParentRoute: app,
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
  component: Outlet,
});
const authed = () => authedRoute;

export const settingsRoute = createRoute({
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

/** Anything else, inside the shell. Public: a wrong address is not a reason to demand a sign-in. */
export const catchAllRoute = createRoute({
  getParentRoute: app,
  path: "$",
  component: () => <Empty>There is nothing at this address.</Empty>,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  consentRoute,
  appRoute.addChildren([
    homeRoute,
    authedRoute.addChildren([
      settingsRoute,
      devTokenRoute,
      devTokenCallbackRoute,
      adminRoute.addChildren([adminUsersRoute, adminAllowlistRoute, adminAuditRoute]),
    ]),
    catchAllRoute,
  ]),
]);

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
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
