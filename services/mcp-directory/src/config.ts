/**
 * Environment -> Config. The resource and issuer are derived from PUBLIC_ORIGIN
 * so they cannot drift from services/auth's registry line for "directory";
 * only the internal address of the auth service is a separate knob.
 */
import { z } from "zod";

export const RESOURCE_NAME = "directory";

export const configSchema = z.object({
  /** Public origin of the single-origin deployment, e.g. https://herkules.dev or http://localhost:3000. */
  PUBLIC_ORIGIN: z.string().url(),
  /** Base URL this process uses to reach the auth service (JWKS, user-info). Defaults to PUBLIC_ORIGIN. */
  AUTH_INTERNAL_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3002),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface Config {
  readonly origin: string;
  /** Canonical resource URL and the exact `aud` this server accepts. */
  readonly resource: string;
  /** `iss` of every accepted token. */
  readonly issuer: string;
  /** Prefix for server-to-server calls: `${authInternal}/auth/...`. */
  readonly authInternal: string;
  readonly port: number;
  readonly isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = configSchema.parse(env);
  const origin = new URL(raw.PUBLIC_ORIGIN).origin;
  const authInternal = raw.AUTH_INTERNAL_URL ? new URL(raw.AUTH_INTERNAL_URL).origin : origin;
  return {
    origin,
    resource: `${origin}/mcp/${RESOURCE_NAME}`,
    issuer: `${origin}/auth`,
    authInternal,
    port: raw.PORT,
    isProduction: raw.NODE_ENV === "production",
  };
}
