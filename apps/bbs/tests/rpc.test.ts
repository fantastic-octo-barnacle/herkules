/**
 * The RPC contract is a compile-time artefact: `hc<AppType>` must know every
 * query key and every literal union. These assertions fail `vp check`, not
 * `vp test`, which is the point — a typo in the SPA cannot reach a browser.
 */
import { hc } from "hono/client";
import { describe, expect, it } from "vite-plus/test";

import type { ArticleAiDTO, ViewerDTO, Wire } from "../src/api/dto.ts";
import type { AppType } from "../src/api/routes.ts";
import type { ArticleLink } from "../src/library/types.ts";

describe("hc<AppType>", () => {
  it("types query inputs and keeps literal unions on the wire", () => {
    const api = hc<AppType>("http://bbs.test", { fetch: async () => new Response("{}") });
    void api.api.articles.$get({ query: { q: "步兵", scope: "title", limit: "5" } });
    // @ts-expect-error `scpoe` is not a query key: the validator middleware is what makes hc see inputs.
    void api.api.articles.$get({ query: { scpoe: "title" } });
    // @ts-expect-error `q` is required on the ranked search.
    void api.api.search.$get({ query: {} });
    // @ts-expect-error not a scope.
    void api.api.search.$get({ query: { q: "x", scope: "body" } });
    void api.api.articles[":id"].content.$get({ param: { id: "x" }, query: { format: "html" } });

    const role: ViewerDTO["role"] = "member";
    // @ts-expect-error literal unions survive Wire<T>; "owner" is not a role.
    const bad: ViewerDTO["role"] = "owner";
    const status: ArticleAiDTO["status"] = "pending";
    const kind: Wire<ArticleLink>["kind"] = "repository";
    const id: Wire<ArticleLink>["articleId"] = "plain string, brand erased";
    expect([role, bad, status, kind, id]).toHaveLength(5);
  });
});
