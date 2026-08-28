/**
 * Sign-in state in the header. Renders NOTHING until `q.viewer()` settles, so a
 * signed-in reader never sees 登录 flash. Sign-out is not here — it is a POST
 * form on /account (one place that can be CSRF-shaped), the chip only links there.
 */
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
      <a className="shell-login" href={`/login?next=${encodeURIComponent(pathname + searchStr)}`}>
        登录
      </a>
    );
  }
  return (
    <Link className="shell-account" to="/account">
      {viewer.avatarUrl ? (
        <img className="shell-avatar" src={viewer.avatarUrl} alt="" width={22} height={22} />
      ) : null}
      <span>{viewer.displayName}</span>
    </Link>
  );
}
