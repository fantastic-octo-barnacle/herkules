/**
 * Per-route error boundary (applied by routes.tsx), so a failed fetch never
 * replaces the header. `ApiError` carries the server's own `error_description`;
 * anything else gets one generic line rather than a stack trace.
 */
import { Link, useRouter } from "@tanstack/react-router";

import { ApiError } from "../api/client.ts";

const GENERIC = "请求没有完成，请稍后重试。";

export function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="page">
      <section className="card shell-state" role="alert">
        <p className="eyebrow">错误</p>
        <h1 className="page-title">出错了</h1>
        <p>{error instanceof ApiError ? error.message : GENERIC}</p>
        <div className="shell-state-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void router.invalidate()}
          >
            重试
          </button>
          <Link className="btn" to="/">
            回到首页
          </Link>
        </div>
      </section>
    </div>
  );
}
