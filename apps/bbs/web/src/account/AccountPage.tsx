/**
 * `/account` — identity and the MCP snippet, nothing else. rm-wenku's personal
 * access tokens and chat quota are gone: this deployment authenticates with the
 * platform session and its MCP endpoint is read-only.
 */
import { Alert, AlertDescription } from "@herkules/ui/components/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@herkules/ui/components/avatar";
import { Button } from "@herkules/ui/components/button";
import { useSuspenseQuery } from "@tanstack/react-query";

import type { ViewerDTO } from "../../../src/api/dto.ts";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { accountRoute } from "../routes.tsx";
import { loginErrorText } from "./loginError.ts";
import { McpGuide } from "./McpGuide.tsx";

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

const PANEL = "rounded-lg border border-line bg-surface px-[1.4rem] py-5 [&+section]:mt-4";

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
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}
      {viewer ? (
        <section className={PANEL}>
          <h2>个人资料</h2>
          <div className="flex flex-wrap items-center gap-[0.9rem]">
            {viewer.avatarUrl ? (
              <Avatar size="lg" className="size-12 border border-line bg-surface-2">
                <AvatarImage src={viewer.avatarUrl} alt="" />
                <AvatarFallback />
              </Avatar>
            ) : null}
            <div>
              <div className="text-[1.1rem] text-ink">{viewer.displayName}</div>
              <div className="meta">{roleText(viewer.role)}</div>
            </div>
          </div>
          {/* Sign-out is the Hono app's POST, not a route: a real form, so it works without JS. */}
          <form className="mt-4" method="post" action="/logout">
            <input type="hidden" name="next" value="/" />
            <Button variant="outline" type="submit">
              退出
            </Button>
          </form>
        </section>
      ) : (
        <section className={PANEL}>
          <h2>登录</h2>
          <p>浏览与搜索不需要登录。登录后可以把本站接入 AI 助手，并按你的身份使用 MCP 服务。</p>
          <p>
            {/* The OAuth start lives on the API, not in the router. */}
            <Button asChild>
              <a href="/login?next=%2Faccount">登录</a>
            </Button>
          </p>
        </section>
      )}
      <McpGuide />
    </div>
  );
}
