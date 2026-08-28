/** Header, nav and the page column every signed-in screen sits in. */
import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Button } from "@herkules/ui/components/button";
import { Link, Outlet } from "@tanstack/react-router";

import { useSession } from "./session.tsx";

const NAV = "border-b-2 border-transparent py-0.5 text-ink-2 hover:text-ink hover:no-underline";
const ACTIVE = { className: "border-b-2 border-accent py-0.5 text-ink hover:no-underline" };

export function Shell() {
  const { api, session, isAdmin, refresh } = useSession();
  async function signOut() {
    await api.signOut();
    await refresh();
    location.assign("/login");
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-baseline gap-6 border-b border-line bg-surface px-6 py-3.5">
        <Link
          to="/"
          className="font-display text-2xl tracking-[0.01em] text-ink hover:no-underline"
        >
          herkules
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{location.origin}/auth</span>
        <nav className="ml-auto flex flex-wrap items-baseline gap-4" aria-label="Main">
          <Link to="/" activeOptions={{ exact: true }} className={NAV} activeProps={ACTIVE}>
            Settings
          </Link>
          <Link to="/dev-token" className={NAV} activeProps={ACTIVE}>
            Dev token
          </Link>
          {isAdmin ? (
            <>
              <Link
                to="/admin"
                activeOptions={{ exact: true }}
                className={NAV}
                activeProps={ACTIVE}
              >
                Members
              </Link>
              <Link to="/admin/allowlist" className={NAV} activeProps={ACTIVE}>
                Allowlist
              </Link>
              <Link to="/admin/audit" className={NAV} activeProps={ACTIVE}>
                Audit
              </Link>
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
