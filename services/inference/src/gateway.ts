import { enrichModels } from "./model-catalog.ts";
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from "./limits.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { servePortal } from "./portal.ts";
import type { Config } from "./config.ts";
import { AdmissionError, Scheduler, type Lease } from "./queue.ts";
import { body, cancellation, failure, json, matches, relay } from "./http.ts";
import type { Membership } from "./membership.ts";

export interface GatewayDeps {
  config: Config;
  membership: Pick<Membership, "ready" | "check">;
  identifyKey(hash: string): Promise<number | undefined>;
  fetch?: typeof fetch;
}
export function createGateway(deps: GatewayDeps) {
  const { config, membership } = deps;
  const transport = deps.fetch ?? fetch;
  const queue = new Scheduler(config.workers);
  const tickets = new Map<string, { lease: Lease; used: boolean; signal: AbortSignal }>();
  const originHost = new URL(config.AI_PORTAL_ORIGIN).host;
  const apiHost = new URL(config.AI_API_ORIGIN).host;
  const backend = (path: string, req: IncomingMessage, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    for (const name of [
      "authorization",
      "cookie",
      "new-api-user",
      "content-type",
      "origin",
      "user-agent",
    ]) {
      const value = req.headers[name];
      if (typeof value === "string" && !headers.has(name)) headers.set(name, value);
    }
    // New API uses ServerAddress for its public origin; forwarded metadata describes that origin.
    headers.set("x-forwarded-host", originHost);
    // Production exposes this port only to Caddy, which overwrites this header using
    // its trusted Cloudflare client-IP calculation. Local callers use their socket IP.
    const clientIP = req.headers["x-herkules-client-ip"];
    headers.set(
      "x-forwarded-for",
      typeof clientIP === "string" ? clientIP : (req.socket.remoteAddress ?? "127.0.0.1"),
    );
    headers.set("x-forwarded-proto", new URL(config.AI_PORTAL_ORIGIN).protocol.slice(0, -1));
    return transport(config.NEW_API_URL + path, { ...init, headers, redirect: "manual" });
  };
  async function identity(req: IncomingMessage, path: string, signal: AbortSignal) {
    if (path.startsWith("/v1/")) {
      const authorization = req.headers.authorization ?? "";
      if (!/^Bearer sk-[A-Za-z0-9_-]+$/.test(authorization))
        throw new AdmissionError("invalid_api_key", 401);
      // New API remains responsible for revocation, expiry, group/model and IP restrictions.
      const checked = await backend("/v1/models", req, { signal, headers: { cookie: "" } });
      await checked.body?.cancel();
      if (!checked.ok) throw new AdmissionError("invalid_api_key", checked.status);
      const hash = createHash("sha256")
        .update(authorization.slice("Bearer sk-".length))
        .digest("hex");
      const id = await deps.identifyKey(hash);
      if (!id) throw new AdmissionError("invalid_api_key", 401);
      return id;
    }
    const response = await backend("/api/user/self", req, { signal });
    const value = (await response.json()) as { success?: boolean; data?: { id: number } };
    if (!response.ok || !value.success || !Number.isInteger(value.data?.id))
      throw new AdmissionError("sign_in_required", 401);
    return value.data!.id;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const cancel = cancellation(req, res);
    try {
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url ?? "/", "http://gateway").pathname);
      } catch {
        throw new AdmissionError("invalid_path", 400);
      }
      // Reject decoded delimiters and noncanonical segments before forwarding: fetch
      // would otherwise reinterpret them as a query, fragment or a different route.
      if (
        // eslint-disable-next-line no-control-regex -- URL parsers discard ASCII controls.
        /[%\\?#\u0000-\u0020\u007f]/.test(path) ||
        path.includes("//") ||
        path.split("/").some((part) => part === "." || part === "..")
      )
        throw new AdmissionError("invalid_path", 400);
      if (path === "/healthz") {
        json(res, membership.ready ? 200 : 503, { ready: membership.ready, ...queue.status });
        return;
      }
      const portal = req.headers.host === originHost;
      if (!portal && req.headers.host !== apiHost) {
        json(res, 404, { error: "not_found" });
        return;
      }
      if (!membership.ready) throw new AdmissionError("identity_sync_unavailable", 503);
      if (portal && path === "/" && req.method === "GET") {
        res.writeHead(302, { location: "/dashboard", "cache-control": "no-store" });
        res.end();
        return;
      }
      const generation =
        (path === "/v1/chat/completions" || (portal && path === "/pg/chat/completions")) &&
        req.method === "POST";
      const modelDetail = /^\/v1\/models\/.+$/.test(path);
      const models = (path === "/v1/models" || modelDetail) && req.method === "GET";
      if (!portal && !generation && !models) {
        json(res, 404, { error: "not_found" });
        return;
      }
      if (portal && /^\/(?:v1|v1beta|pg)(?:\/|$)/.test(path) && !generation && !models) {
        json(res, 404, { error: "not_found" });
        return;
      }
      // These routes would create independent admission paths or expose first-run administration.
      if (
        portal &&
        (/^\/api\/(?:setup|verification|reset_password|redemption|subscription|task|video|payment|stripe|epay)(?:\/|$)/.test(
          path,
        ) ||
          /^\/api\/user\/(?:login|register|reset|passkey|aff|aff_transfer|topup|pay|amount|stripe|creem|waffo|waffo-pancake|checkin)(?:\/|$)/.test(
            path,
          ) ||
          /^\/api\/oauth\/(?!state$|herkules$)/.test(path) ||
          (req.method === "DELETE" && path.includes("/oauth/bindings")))
      ) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const publicAPI = new Set([
        "/api/status",
        "/api/user/auth/refresh",
        "/api/user/auth/logout",
        "/api/oauth/state",
        "/api/oauth/herkules",
        "/api/notice",
        "/api/about",
        "/api/home_page_content",
        "/api/user-agreement",
        "/api/privacy-policy",
      ]);
      let user: number | undefined;
      if (generation || models || (portal && path.startsWith("/api/") && !publicAPI.has(path))) {
        user = await identity(req, path, cancel.signal);
        if (!(await membership.check(user))) throw new AdmissionError("membership_required", 403);
      }
      if (portal && config.AI_PORTAL_DIR && !path.startsWith("/api/") && !generation && !models) {
        await servePortal(config.AI_PORTAL_DIR, path, req.method ?? "GET", res);
        return;
      }
      if (!generation) {
        const query = new URL(req.url ?? "/", "http://gateway").search;
        const response = await backend(modelDetail && models ? "/v1/models" : path + query, req, {
          method: req.method,
          signal: cancel.signal,
          body: ["GET", "HEAD"].includes(req.method ?? "GET")
            ? undefined
            : new Uint8Array(await body(req)),
        });
        if (models && response.ok) {
          const listing = enrichModels(
            await response.json(),
            config.modelCatalog ?? {},
            config.workers,
          );
          if (modelDetail) {
            const id = path.slice("/v1/models/".length);
            const entry =
              listing &&
              typeof listing === "object" &&
              "data" in listing &&
              Array.isArray(listing.data)
                ? listing.data.find((item: { id?: string }) => item.id === id)
                : undefined;
            if (!entry) throw new AdmissionError("model_not_found", 404);
            json(res, 200, entry);
          } else json(res, response.status, listing);
        } else if (path === "/api/status") {
          const status = (await response.json()) as { data?: Record<string, unknown> };
          if (status.data) status.data.password_login_enabled = false;
          json(res, response.status, status);
        } else {
          if (path === "/api/user/auth/refresh" && response.ok) {
            const result = (await response.clone().json()) as {
              success?: boolean;
              data?: { user?: { id?: number } };
            };
            if (
              result.success &&
              (!result.data?.user?.id || !(await membership.check(result.data.user.id)))
            )
              throw new AdmissionError("membership_required", 403);
          }
          await relay(response, res, cancel.signal);
        }
        return;
      }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse((await body(req)).toString());
      } catch (error) {
        if (error instanceof AdmissionError) throw error;
        throw new AdmissionError("invalid_json", 400);
      }
      if (!input || typeof input !== "object" || input.stream !== true)
        throw new AdmissionError("streaming_required", 400);
      const max = input.max_tokens ?? input.max_completion_tokens ?? DEFAULT_OUTPUT_TOKENS;
      if (!Number.isInteger(max) || Number(max) < 1 || Number(max) > MAX_OUTPUT_TOKENS)
        throw new AdmissionError("invalid_output_limit", 400);
      if (!Array.isArray(input.messages) || typeof input.model !== "string")
        throw new AdmissionError("invalid_chat_request", 400);
      const defaults = config.modelCatalog?.[input.model]?.defaults;
      for (const [key, value] of Object.entries(defaults ?? {})) {
        if (input[key] === undefined) input[key] = value;
      }
      input.max_tokens = max;
      delete input.max_completion_tokens;
      input.stream_options = { include_usage: true };
      const lease = await queue.acquire(String(user), input.model, cancel.signal);
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, { lease, used: false, signal: cancel.signal });
      try {
        // Recheck admission after queueing; revocation while waiting must not start a job.
        if (!membership.ready || !(await membership.check(user!)))
          throw new AdmissionError("membership_required", 403);
        const response = await backend(path, req, {
          method: "POST",
          signal: cancel.signal,
          headers: { "content-type": "application/json", "X-Herkules-Ticket": ticket },
          body: JSON.stringify(input),
        });
        await relay(response, res, cancel.signal);
      } finally {
        tickets.delete(ticket);
        lease.release();
      }
    } catch (error) {
      failure(res, error);
    }
  }
  const internal = createServer(async (req, res) => {
    const cancel = cancellation(req, res);
    try {
      if (!matches(req.headers.authorization, `Bearer ${config.dispatchKey}`))
        throw new AdmissionError("unauthorized", 401);
      if (req.method !== "POST" || req.url !== "/v1/chat/completions")
        throw new AdmissionError("not_found", 404);
      const token = req.headers["x-herkules-ticket"];
      const ticket = typeof token === "string" ? tickets.get(token) : undefined;
      if (!ticket || ticket.used || ticket.signal.aborted)
        throw new AdmissionError("invalid_ticket", 401);
      ticket.used = true;
      const worker = ticket.lease.worker;
      const headers: Record<string, string> = {
        authorization: `Bearer ${worker.key}`,
        "content-type": "application/json",
      };
      if (worker.accessId && worker.accessSecret) {
        headers["CF-Access-Client-Id"] = worker.accessId;
        headers["CF-Access-Client-Secret"] = worker.accessSecret;
      }
      const forwarded = JSON.parse((await body(req)).toString()) as Record<string, unknown>;
      if (forwarded.model !== worker.model) throw new AdmissionError("model_ticket_mismatch", 400);
      const response = await transport(worker.url + "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(forwarded),
        headers,
        redirect: "error",
        signal: AbortSignal.any([ticket.signal, cancel.signal]),
      });
      await relay(response, res, cancel.signal);
    } catch (error) {
      failure(res, error);
    }
  });
  return { public: createServer(handle), internal, queue };
}
