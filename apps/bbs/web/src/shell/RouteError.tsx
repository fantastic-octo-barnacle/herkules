/**
 * Per-route error boundary (applied by routes.tsx), so a failed fetch never
 * replaces the header. `ApiError` carries the server's own `error_description`;
 * anything else gets one generic line rather than a stack trace.
 */
import { Button } from "@herkules/ui/components/button";
import { Link, useRouter } from "@tanstack/react-router";

import { ApiError } from "../api/client.ts";

const GENERIC = "请求没有完成，请稍后重试。";

export function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="page">
      <section
        className="mx-auto my-12 max-w-[34rem] rounded-lg border border-line bg-surface p-6 [&_p]:text-ink-2"
        role="alert"
      >
        <p className="eyebrow mb-1.5">错误</p>
        <h1 className="page-title">出错了</h1>
        <p>{error instanceof ApiError ? error.message : GENERIC}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => void router.invalidate()}>重试</Button>
          <Button variant="outline" asChild>
            <Link to="/">回到首页</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
