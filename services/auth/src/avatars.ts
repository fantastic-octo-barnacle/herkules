/**
 * Avatar cache: GitHub's avatar for each user, stored on a volume, served
 * from herkules.dev so browsers and mainland users never hit GitHub's CDN.
 *
 * Route: GET /auth/avatars/:userId  (public; ids are opaque; GitHub avatars are public anyway)
 * Storage: `${AVATAR_DIR}/${userId}` + `${userId}.meta.json` { etag, contentType, sourceUrl, fetchedAt }
 * Refresh: on every login (user.image may have changed) and lazily when a
 * request finds no file. Failure keeps the old file; never 5xx for a stale avatar.
 * Idempotent: refreshing twice yields the same bytes; concurrent refreshes race benignly (atomic rename).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { GithubApi } from "./github.ts";

export interface Avatars {
  /** Public URL clients embed. Pure. */
  urlFor(userId: string): string;
  /** Serve from cache; on miss fetch from `sourceUrl` first. 404 when the user has no image. Honors If-None-Match. */
  serve(userId: string, request: Request): Promise<Response>;
  /** Fetch `sourceUrl` (the user row's `image`) into the cache. Called from the login after-hook via Users.onLogin. */
  refresh(userId: string, sourceUrl: string | null): Promise<void>;
}

export interface AvatarsDeps {
  readonly dir: string;
  readonly issuer: string;
  readonly github: GithubApi;
  /** userId -> stored GitHub image URL; injected so avatars.ts owns no DB. */
  readonly sourceUrlOf: (userId: string) => Promise<string | null>;
}

interface Meta {
  readonly etag: string;
  readonly contentType: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createAvatars(deps: AvatarsDeps): Avatars {
  const { dir, issuer, github, sourceUrlOf } = deps;
  const fileOf = (id: string) => join(dir, id);
  const metaOf = (id: string) => join(dir, `${id}.meta.json`);
  const readMeta = async (id: string): Promise<Meta | undefined> => {
    try {
      return JSON.parse(await readFile(metaOf(id), "utf8")) as Meta;
    } catch {
      return undefined;
    }
  };

  const refresh = async (userId: string, sourceUrl: string | null): Promise<void> => {
    if (!SAFE_ID.test(userId)) return;
    if (!sourceUrl) {
      await Promise.all([rm(fileOf(userId), { force: true }), rm(metaOf(userId), { force: true })]);
      return;
    }
    const fetched = await github.avatar(sourceUrl);
    if (!fetched) return; // keep the previous file
    await mkdir(dir, { recursive: true });
    const tmp = `${fileOf(userId)}.${process.pid}.tmp`;
    const hash = createHash("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(fetched.body as never), tap, createWriteStream(tmp));
      const meta: Meta = {
        etag: `"${hash.digest("hex").slice(0, 32)}"`,
        contentType: fetched.contentType,
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      };
      await rename(tmp, fileOf(userId));
      await writeFile(metaOf(userId), JSON.stringify(meta));
    } catch {
      await rm(tmp, { force: true });
    }
  };

  return {
    urlFor: (userId) => `${issuer}/avatars/${userId}`,
    async serve(userId, request) {
      if (!SAFE_ID.test(userId)) return new Response("not found", { status: 404 });
      let meta = await readMeta(userId);
      if (!meta) {
        await refresh(userId, await sourceUrlOf(userId));
        meta = await readMeta(userId);
      }
      if (!meta)
        return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
      const headers = new Headers({
        "content-type": meta.contentType,
        etag: meta.etag,
        "cache-control": "public, max-age=3600",
      });
      if (request.headers.get("if-none-match") === meta.etag)
        return new Response(null, { status: 304, headers });
      let size: number;
      try {
        size = (await stat(fileOf(userId))).size;
      } catch {
        return new Response("not found", { status: 404 });
      }
      headers.set("content-length", String(size));
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(Readable.toWeb(createReadStream(fileOf(userId))) as ReadableStream, {
        status: 200,
        headers,
      });
    },
    refresh,
  };
}
