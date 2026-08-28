/**
 * One app the way apps/bbs will build it: apiResource + createOAuthClient +
 * honoOAuth, against createFakeIssuer. Every test file starts here.
 */
import { apiResource } from "@herkules/auth-middleware";
import { Hono } from "hono";

import { honoOAuth, type HonoOAuthOptions, type ViewerEnv } from "../src/hono.ts";
import { createOAuthClient, type SessionEvent } from "../src/index.ts";
import { createFakeIssuer } from "../src/testing.ts";

export const ORIGIN = "https://bbs.example.test";
export const ISSUER = "https://herkules.example.test/auth";
export const RESOURCE = "https://herkules.example.test/api/bbs";
export const CLIENT = { id: "bbs", secret: "s".repeat(32) };
export const COOKIE_SECRET = "c".repeat(32);

export interface Clock {
  now(): Date;
  advance(seconds: number): void;
}

export function createClock(start = Date.now()): Clock {
  let offset = 0;
  const real = Date.now();
  return {
    now: () => new Date(start + (Date.now() - real) + offset),
    advance: (seconds) => {
      offset += seconds * 1000;
    },
  };
}

export async function setup(opts?: {
  readonly ttl?: number;
  readonly clock?: Clock;
  readonly origin?: string;
  /** Override the secret the CLIENT presents (the fake keeps expecting CLIENT.secret). */
  readonly clientSecret?: string;
  readonly hono?: HonoOAuthOptions;
}) {
  const origin = opts?.origin ?? ORIGIN;
  const clock = opts?.clock ?? createClock();
  const fake = await createFakeIssuer({
    issuer: ISSUER,
    client: { ...CLIENT, redirectUri: `${origin}/callback` },
    resource: RESOURCE,
    now: () => clock.now(),
    ...(opts?.ttl !== undefined ? { accessTokenTtlSeconds: opts.ttl } : {}),
  });
  /** Token/revoke transport; `down` simulates the issuer being unreachable for the app (JWKS stays up). */
  const network = { down: false, calls: 0 };
  const fetch: typeof globalThis.fetch = (input, init) => {
    network.calls += 1;
    if (network.down) return Promise.reject(new TypeError("fetch failed: issuer down"));
    return fake.fetch(input, init);
  };
  const auth = apiResource({ resource: RESOURCE, issuer: ISSUER, fetch: fake.fetch });
  const events: SessionEvent[] = [];
  const client = createOAuthClient({
    auth,
    client: { id: CLIENT.id, secret: opts?.clientSecret ?? CLIENT.secret },
    origin,
    cookieSecret: COOKIE_SECRET,
    fetch,
    now: () => clock.now(),
    onEvent: (e) => events.push(e),
  });
  const oauth = honoOAuth(client, opts?.hono);

  const app = new Hono<ViewerEnv>();
  app.route("/", oauth.routes);
  app.use("/api/*", oauth.viewer());
  app.get("/api/me", (c) =>
    c.json(
      c.var.principal
        ? { subject: c.var.principal.subject, role: c.var.principal.role, via: "handler" }
        : null,
    ),
  );
  app.post("/api/notes", oauth.guard({ role: "member" }), (c) =>
    c.json({ ok: true, subject: c.var.principal.subject }),
  );
  app.delete("/api/notes", oauth.guard({ role: "admin" }), (c) => c.json({ ok: true }));
  // A guarded route outside viewer() that returns a raw Response: Set-Cookie must still land on it.
  app.get("/raw", oauth.guard(), (c) => new Response(`raw:${c.var.principal.subject}`));

  return { fake, auth, client, oauth, app, events, network, clock, origin };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

export const cookieValue = (setCookie: string): string => setCookie.split(";")[0] ?? "";

export const isCleared = (setCookie: string): boolean => /;\s*Max-Age=0(;|$)/i.test(setCookie);

export function request(
  path: string,
  init?: RequestInit & { readonly cookie?: string },
  origin = ORIGIN,
): Request {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return new Request(`${origin}${path}`, { ...init, headers });
}
