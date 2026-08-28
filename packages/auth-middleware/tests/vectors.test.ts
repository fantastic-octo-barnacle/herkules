/**
 * Runs docs/tokens-vectors.json through the TypeScript verifier. The same
 * file drives docs/verify_token.py, so both implementations agree on every
 * vector by construction.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { mcpResource } from "../src/index.ts";

interface Vector {
  name: string;
  token: string | null;
  expect: {
    status: number;
    www_authenticate: string | null;
    principal?: { sub: string; role: string; client_id: string; jti: string };
  };
}
interface Vectors {
  contract_version: number;
  issuer: string;
  resource: string;
  resource_metadata_url: string;
  jwks: { keys: Record<string, unknown>[] };
  vectors: Vector[];
}

const file = JSON.parse(
  readFileSync(new URL("../../../docs/tokens-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const auth = mcpResource({
  resource: file.resource,
  issuer: file.issuer,
  fetch: async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === `${file.issuer}/jwks`
      ? Response.json(file.jwks)
      : new Response("not found", { status: 404 });
  },
});

describe(`conformance vectors (contract_version ${file.contract_version})`, () => {
  test("metadata URL derivation matches the vectors", () => {
    expect(auth.resourceMetadataUrl).toBe(file.resource_metadata_url);
  });

  test.each(file.vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const request = new Request(file.resource, {
      headers: v.token === null ? {} : { authorization: `Bearer ${v.token}` },
    });
    const outcome = await auth.authenticate(request);
    if (outcome.ok) {
      expect(v.expect.status).toBe(200);
      expect({
        sub: outcome.principal.subject,
        role: outcome.principal.role,
        client_id: outcome.principal.clientId,
        jti: outcome.principal.tokenId,
      }).toEqual(v.expect.principal);
    } else {
      expect(outcome.response.status).toBe(v.expect.status);
      expect(outcome.response.headers.get("www-authenticate")).toBe(v.expect.www_authenticate);
    }
  });
});
