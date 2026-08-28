/**
 * Sign-in state in the header. Renders NOTHING until `q.viewer()` settles, so a
 * signed-in reader never sees 登录 flash. Sign-out is not here — it is a POST
 * form on /account (one place that can be CSRF-shaped), the chip only links there.
 */
import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Button } from "@herkules/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useRouteContext } from "@tanstack/react-router";

export function AccountChip() {
  // `from: "__root__"` rather than importing rootRoute: routes.tsx imports App,
  // which imports this file, and the cycle breaks the module graph.
  const { q } = useRouteContext({ from: "__root__" });
  const { pathname, searchStr } = useLocation();
  const { data } = useQuery(q.viewer());

  if (data === undefined) return null;
  const viewer = data.viewer;
  if (!viewer) {
    // The OAuth start is the Hono app's, not a route: a plain anchor, not <Link>.
    return (
      <Button variant="outline" size="xs" asChild>
        <a href={`/login?next=${encodeURIComponent(pathname + searchStr)}`}>登录</a>
      </Button>
    );
  }
  return (
    <Link
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2 hover:text-ink hover:no-underline"
      to="/account"
    >
      <Avatar size="sm" className="size-[1.375rem] border border-line bg-surface-2">
        {viewer.avatarUrl ? <AvatarImage src={viewer.avatarUrl} alt="" /> : null}
        <AvatarFallback />
      </Avatar>
      <span>{viewer.displayName}</span>
    </Link>
  );
}
