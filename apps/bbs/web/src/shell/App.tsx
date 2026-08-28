/**
 * The shell: header (wordmark, nav, theme toggle, account) + <Outlet/> + footer.
 * It never touches `document.title` — screens own that through `usePageTitle`,
 * so the server-injected <title> of a deep link survives the first paint.
 */
import { Link, Outlet } from "@tanstack/react-router";

import { AccountChip } from "./AccountChip.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

const ACTIVE = { className: "is-current" };

export function App() {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-bar">
          <Link className="shell-wordmark" to="/">
            RM 文库
          </Link>
          <nav className="shell-nav" aria-label="站点导航">
            {/* The feed is active on "/" only: every article link would otherwise
                light it up, and /search has its own entry point in the feed. */}
            <Link to="/" activeOptions={{ exact: true }} activeProps={ACTIVE}>
              文章
            </Link>
            <Link to="/kb" activeProps={ACTIVE}>
              知识库
            </Link>
            <Link to="/tags" activeProps={ACTIVE}>
              标签
            </Link>
            <Link to="/status" activeProps={ACTIVE}>
              状态
            </Link>
            <Link to="/about" activeProps={ACTIVE}>
              关于
            </Link>
          </nav>
          <div className="shell-tail">
            <AccountChip />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
      <footer className="shell-footer">
        <div>
          <div>非官方归档 · 正文与图片版权归原作者与 RoboMaster 所有</div>
          <div>
            <Link to="/about">关于本站</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
