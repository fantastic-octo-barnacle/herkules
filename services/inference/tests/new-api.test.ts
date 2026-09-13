import { afterEach, expect, test, vi } from "vite-plus/test";
import { NewAPI } from "../src/new-api.ts";

afterEach(() => vi.unstubAllGlobals());

/**
 * A fake new-api management API that counts session issuance. Every login answers with an
 * access token that is already inside the 60-second renewal window, so each `login()` call
 * has to decide between refreshing and re-authenticating.
 */
function fixture() {
  const calls: string[] = [];
  const state = { refreshOk: true, expiresIn: 30, rateLimited: false };
  let issued = 0;
  const bundle = (init?: ResponseInit) =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          user: { id: 1 },
          access_token: `access-${++issued}`,
          access_expires_at: Math.floor(Date.now() / 1000) + state.expiresIn,
          session: { sid: `sid-${issued}` },
        },
      }),
      init,
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const headers = init.headers as Record<string, string>;
      calls.push(
        `${init.method} ${path} cookie=${headers.cookie} auth=${headers.authorization ?? ""}`,
      );
      switch (path) {
        case "/api/user/login":
          if (state.rateLimited) return new Response(null, { status: 429 });
          return bundle({
            headers: [
              ["set-cookie", `new_api_refresh=r${issued + 1}; Path=/api/user/auth; HttpOnly`],
            ],
          });
        case "/api/user/auth/refresh":
          if (!state.refreshOk || !headers.cookie.includes("new_api_refresh="))
            return Response.json({ success: false, code: "AUTH_REFRESH_INVALID" }, { status: 401 });
          return bundle({
            headers: [
              ["set-cookie", `new_api_refresh=r${issued + 1}; Path=/api/user/auth; HttpOnly`],
            ],
          });
        case "/api/user/self/sessions/revoke-others":
        case "/api/user/auth/logout":
          return Response.json({ success: true, data: {} });
        default:
          return Response.json({ success: false }, { status: 404 });
      }
    }),
  );
  return { api: new NewAPI("http://new-api:3000", "root-password"), calls, state };
}

test("password login happens once, later renewals refresh the same session", async () => {
  const f = fixture();
  await f.api.login();
  expect(f.calls).toEqual([
    "POST /api/user/login cookie= auth=",
    "POST /api/user/self/sessions/revoke-others cookie=new_api_refresh=r1 auth=Bearer access-1",
  ]);
  f.calls.length = 0;
  await f.api.login();
  expect(f.calls).toEqual([
    "POST /api/user/auth/refresh cookie=new_api_refresh=r1 auth=Bearer access-1",
  ]);
  f.calls.length = 0;
  // The rotated refresh cookie is what the next renewal presents.
  await f.api.login();
  expect(f.calls).toEqual([
    "POST /api/user/auth/refresh cookie=new_api_refresh=r2 auth=Bearer access-2",
  ]);
});

test("a token that is still fresh is not renewed", async () => {
  const f = fixture();
  f.state.expiresIn = 900;
  await f.api.login();
  f.calls.length = 0;
  await f.api.login();
  expect(f.calls).toEqual([]);
});

test("a rejected refresh falls back to a password login and purges stale sessions", async () => {
  const f = fixture();
  await f.api.login();
  f.calls.length = 0;
  f.state.refreshOk = false;
  await f.api.login();
  expect(f.calls.map((c) => c.split(" ")[1])).toEqual([
    "/api/user/auth/refresh",
    "/api/user/login",
    "/api/user/self/sessions/revoke-others",
  ]);
});

test("logout releases the session and forgets the cookie", async () => {
  const f = fixture();
  await f.api.login();
  f.calls.length = 0;
  await f.api.logout();
  expect(f.calls).toEqual([
    "POST /api/user/auth/logout cookie=new_api_refresh=r1 auth=Bearer access-1",
  ]);
  f.calls.length = 0;
  await f.api.logout();
  expect(f.calls).toEqual([]);
  await f.api.login();
  expect(f.calls[0]).toBe("POST /api/user/login cookie= auth=");
});

test("a bodiless rate-limit rejection reports the status instead of a parse error", async () => {
  const f = fixture();
  f.state.rateLimited = true;
  await expect(f.api.login()).rejects.toThrow("POST /api/user/login (429)");
});
