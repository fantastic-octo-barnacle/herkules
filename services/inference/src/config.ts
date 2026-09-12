import { catalogSchema, modelCatalog } from "./model-catalog.ts";
import { readFile } from "node:fs/promises";
import { z } from "zod";
const workerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  model: z.string().min(1),
  url: z.string().url(),
  keyFile: z.string(),
  capacity: z.number().int().min(1).max(16).optional(),
  perUser: z.number().int().min(1).max(16).optional(),
  resourceGroup: z.string().min(1).optional(),
  accessIdFile: z.string().optional(),
  accessSecretFile: z.string().optional(),
});
export async function readSecret(path: string) {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 16 || /\s/.test(value)) throw new Error(`Invalid credential file: ${path}`);
  return value;
}
export async function loadConfig(env = process.env) {
  const schema = z.object({
    PORT: z.coerce.number().default(4010),
    INTERNAL_PORT: z.coerce.number().default(4013),
    AI_PORTAL_DIR: z.string().optional(),
    NEW_API_URL: z.string().url().default("http://new-api:3000"),
    AI_OAUTH_BACKCHANNEL: z.string().url().optional(),
    AI_DISPATCH_URL: z.string().url().default("http://inference:4013"),
    AI_PORTAL_ORIGIN: z.string().url(),
    AI_API_ORIGIN: z.string().url(),
    AUTH_ISSUER: z.string().url(),
    AUTH_INTERNAL_URL: z.string().url(),
    AI_CLIENT_SECRET_FILE: z.string(),
    AI_SYNC_SECRET_FILE: z.string(),
    AI_ROOT_PASSWORD_FILE: z.string(),
    AI_DISPATCH_KEY_FILE: z.string(),
    AI_METADATA_DATABASE_URL: z.string(),
    AI_WORKERS_FILE: z.string(),
    AI_MODEL_CATALOG_FILE: z.string().optional(),
  });
  const values = schema.parse(env);
  const definitions = z
    .array(workerSchema)
    .min(1)
    .parse(JSON.parse(await readFile(values.AI_WORKERS_FILE, "utf8")));
  if (new Set(definitions.map((w) => w.id)).size !== definitions.length)
    throw new Error("Duplicate worker IDs");
  const workers = await Promise.all(
    definitions.map(async (w) => {
      const local = ["localhost", "127.0.0.1", "mock-worker", "host.docker.internal"].includes(
        new URL(w.url).hostname,
      );
      if (
        !local &&
        (new URL(w.url).protocol !== "https:" || !w.accessIdFile || !w.accessSecretFile)
      ) {
        throw new Error("Remote workers require HTTPS and Cloudflare Access credentials");
      }
      if (!!w.accessIdFile !== !!w.accessSecretFile)
        throw new Error("Both Access credential files are required");
      return {
        id: w.id,
        model: w.model,
        capacity: w.capacity,
        perUser: w.perUser,
        resourceGroup: w.resourceGroup,
        url: w.url.replace(/\/$/, ""),
        key: await readSecret(w.keyFile),
        accessId: w.accessIdFile ? await readSecret(w.accessIdFile) : undefined,
        accessSecret: w.accessSecretFile ? await readSecret(w.accessSecretFile) : undefined,
      };
    }),
  );
  return {
    ...values,
    modelCatalog: values.AI_MODEL_CATALOG_FILE
      ? catalogSchema.parse(JSON.parse(await readFile(values.AI_MODEL_CATALOG_FILE, "utf8")))
      : modelCatalog,
    workers,
    clientSecret: await readSecret(values.AI_CLIENT_SECRET_FILE),
    syncSecret: await readSecret(values.AI_SYNC_SECRET_FILE),
    rootPassword: await readSecret(values.AI_ROOT_PASSWORD_FILE),
    dispatchKey: await readSecret(values.AI_DISPATCH_KEY_FILE),
  };
}
export type Config = Awaited<ReturnType<typeof loadConfig>>;
