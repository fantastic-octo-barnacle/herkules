/**
 * `/account` — identity and the MCP snippet, nothing else. rm-wenku's personal
 * access tokens and chat quota are gone: this deployment authenticates with the
 * platform session and its MCP endpoint is read-only.
 */
import { useSuspenseQuery } from "@tanstack/react-query";

import type { ViewerDTO } from "../../../src/api/dto.ts";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { accountRoute } from "../routes.tsx";
import { loginErrorText } from "./loginError.ts";
import { McpGuide } from "./McpGuide.tsx";
import "./account.css";

/** Exhaustive over the wire's literal union: a new role is a compile error here. */
function roleText(role: ViewerDTO["role"]): string {
  switch (role) {
    case "admin":
      return "管理员";
    case "member":
      return "成员";
    default: {
      const never: never = role;
      return never;
    }
  }
}

export function AccountPage() {
  usePageTitle("账户");
  const { login_error: loginError } = accountRoute.useSearch();
  const { q } = accountRoute.useRouteContext();
  const { data } = useSuspenseQuery(q.viewer());
  const viewer = data.viewer;
  const errorText = loginErrorText(loginError);

  return (
    <div className="page">
      <h1 className="page-title">账户</h1>
      {errorText ? (
        <p className="account-error" role="alert">
          {errorText}
        </p>
      ) : null}
      {viewer ? (
        <section className="card account-panel">
          <h2>个人资料</h2>
          <div className="account-identity">
            {viewer.avatarUrl ? (
              <img
                className="shell-avatar is-large"
                src={viewer.avatarUrl}
                alt=""
                width={48}
                height={48}
              />
            ) : null}
            <div>
              <div className="account-name">{viewer.displayName}</div>
              <div className="meta">{roleText(viewer.role)}</div>
            </div>
          </div>
          {/* Sign-out is the Hono app's POST, not a route: a real form, so it works without JS. */}
          <form className="account-signout" method="post" action="/logout">
            <input type="hidden" name="next" value="/" />
            <button className="btn" type="submit">
              退出
            </button>
          </form>
        </section>
      ) : (
        <section className="card account-panel">
          <h2>登录</h2>
          <p>浏览与搜索不需要登录。登录后可以把本站接入 AI 助手，并按你的身份使用 MCP 服务。</p>
          <p>
            {/* The OAuth start lives on the API, not in the router. */}
            <a className="btn btn-primary" href="/login?next=%2Faccount">
              登录
            </a>
          </p>
        </section>
      )}
      <McpGuide />
    </div>
  );
}
