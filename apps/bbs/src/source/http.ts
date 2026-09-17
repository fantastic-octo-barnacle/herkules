/**
 * The one HTTP client. Port of wenku-source/http.rs. Every request:
 *
 *   lease = await guard.acquire(priority)   →  fetch  →  lease.ok() | lease.failed(kind, retryAfter, msg)
 *
 * The Lease makes "every request settles exactly once" a shape the caller
 * cannot forget: the only way to get one is to be about to send a request,
 * and the only thing to do with it is settle it. The adapter (robomaster.ts)
 * never sees the guard; the guard never sees a URL. No retries here: the
 * guard IS the retry policy, and it is persistent.
 *
 * Origin policy: https only, `url.origin === origin` exactly, and the
 * loopback/private ranges (localhost, *.local, 127., 10., 192.168., 169.254.,
 * 172.16-31.) are refused even if someone changes the constant.
 * `redirect: "manual"` — a 3xx is http{status} and never followed.
 * Timeouts: one AbortSignal at REQUEST_TIMEOUT_MS. fetch() has no separate
 * connect timeout; rm-wenku's 10 s connect + 15 s total collapse to 15 s
 * (deviation from rm-wenku, recorded in README.md §"Crawler policy").
 * Body cap: Content-Length pre-check, then a streaming read that aborts past
 * MAX_BODY_BYTES → tooLarge.
 * Settling: a failure whose breakerKind is non-null settles `failed(...)`; every
 * other outcome (2xx parsed, notFound, invalid, tooLarge, other 4xx, 3xx) settles
 * `ok()` — the server answered, so the breaker is not tripped, and the count was
 * taken at acquire either way. rm-wenku's http.rs had the same two-way split.
 *
 * Classification → SourceFailure: 429 http(retryAfter) · 403 forbidden ·
 * 404 notFound · other non-2xx http · fetch throws → network · 2xx non-JSON
 * → blocked · 2xx json content-type but unparsable → invalid.
 */
import type { Guard } from "../guard/index.ts";
import type { Priority } from "../guard/policy.ts";
import { SourceError, breakerKind } from "./index.ts";

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const USER_AGENT =
  "rm-wenku/0.2 (+public article monitoring; rate limited; https://github.com/fantastic-octo-barnacle/rm-wenku)";

export interface JsonClientDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly guard: Guard;
  /** `https://bbs.robomaster.com` — the only origin this client will talk to. Constant, not config. */
  readonly origin: string;
}

export interface JsonClient {
  /**
   * POST `origin + path` with a JSON body; returns the parsed JSON as `unknown`
   * (the adapter validates it — wire parsing stays in robomaster.ts).
   * Throws SourceError or ThrottledError (from acquire; nothing was sent).
   * INVARIANT: exactly one acquire per call and, if it proceeded, exactly one settle.
   */
  postJson(path: string, body: unknown, priority: Priority): Promise<unknown>;
}

export function createJsonClient(deps: JsonClientDeps): JsonClient {
  return {
    async postJson(path, body, priority) {
      const url = checkUrl(new URL(path, deps.origin), deps.origin);
      const lease = await deps.guard.acquire(priority);
      try {
        let res: Response;
        try {
          res = await deps.fetch(url, {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "user-agent": USER_AGENT,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (e) {
          throw new SourceError({ kind: "network", message: errorMessage(e) });
        }
        const failure = classify(res);
        if (failure) throw new SourceError(failure);
        const text = await readCapped(res, MAX_BODY_BYTES);
        const isJsonType = (res.headers.get("content-type") ?? "").toLowerCase().includes("json");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new SourceError(
            isJsonType
              ? { kind: "invalid", message: "body is not JSON" }
              : {
                  kind: "blocked",
                  message: `non-JSON ${res.status} response (${text.length} chars)`,
                },
          );
        }
        await lease.ok();
        return json;
      } catch (e) {
        const err = SourceError.is(e)
          ? e
          : new SourceError({ kind: "network", message: errorMessage(e) });
        const kind = breakerKind(err);
        if (kind) {
          const retryAfter = err.failure.kind === "http" ? err.failure.retryAfterSec : null;
          await lease.failed(kind, retryAfter, err.message);
        } else {
          await lease.ok();
        }
        throw err;
      }
    },
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Status → failure, or null for a 2xx. */
function classify(res: Response): SourceError["failure"] | null {
  const { status } = res;
  if (status >= 200 && status < 300) return null;
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "http", status, retryAfterSec: retryAfterOf(res) };
}

function retryAfterOf(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*)$/i;

/** https only, exact origin match, no private/loopback host. */
export function checkUrl(url: URL, allowedOrigin: string): URL {
  if (url.protocol !== "https:") {
    throw new SourceError({ kind: "invalid", message: `refusing non-https url ${url.href}` });
  }
  if (url.origin !== allowedOrigin) {
    throw new SourceError({ kind: "invalid", message: `refusing url outside ${allowedOrigin}` });
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new SourceError({ kind: "invalid", message: `refusing private host ${url.hostname}` });
  }
  return url;
}

/** Reads at most `maxBytes`; throws SourceError tooLarge rather than truncating silently. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourceError({ kind: "tooLarge", bytes: declared });
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceError({ kind: "tooLarge", bytes: total });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}
