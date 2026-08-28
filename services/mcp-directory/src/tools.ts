/**
 * The directory's tools, built per request around the verified caller. The
 * principal comes from `@herkules/auth-middleware` (already checked: signature,
 * issuer, audience = this resource, role); the tools only add what the
 * user-info API knows (names, avatars) by forwarding the caller's own token.
 */
import type { Principal } from "@herkules/auth-middleware";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Member, UserInfo } from "@herkules/auth-middleware/userinfo";
import { UserInfoError } from "@herkules/auth-middleware/userinfo";

export const SERVER_INFO = { name: "herkules-directory", version: "1.0.0" } as const;

export interface DirectoryDeps {
  readonly userInfo: UserInfo;
}

const memberOutput = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string(),
  githubId: z.string(),
});

const whoamiOutput = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  githubId: z.string().optional(),
  role: z.enum(["admin", "member"]),
  clientId: z.string(),
  resource: z.string(),
  tokenExpiresAt: z.string(),
  sessionId: z.string().optional(),
});

export function createDirectoryServer(principal: Principal, deps: DirectoryDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Internal team directory. Every caller is a verified herkules member; ids are opaque and stable.",
  });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "The verified caller: opaque user id, display name, role, which client obtained the token, and when the token expires.",
      inputSchema: z.object({}),
      outputSchema: whoamiOutput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const me = await deps.userInfo
        .member(principal.token, principal.subject)
        .catch(swallowUpstream);
      const out: z.infer<typeof whoamiOutput> = {
        id: principal.subject,
        ...(me
          ? { displayName: me.displayName, avatarUrl: me.avatarUrl, githubId: me.githubId }
          : {}),
        role: principal.role,
        clientId: principal.clientId,
        resource: principal.resource,
        tokenExpiresAt: principal.expiresAt.toISOString(),
        ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
      };
      return structured(out, describeCaller(out));
    },
  );

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description:
        "Every active member of the team: opaque id, display name, avatar URL, GitHub id.",
      inputSchema: z.object({}),
      outputSchema: z.object({ members: z.array(memberOutput) }),
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const members = await deps.userInfo.members(principal.token);
        return structured(
          { members },
          members.length === 0
            ? "No members."
            : members.map((m) => `${m.displayName} (${m.id})`).join("\n"),
        );
      }),
  );

  server.registerTool(
    "get_member",
    {
      title: "Get member",
      description: "One member by opaque id, as returned by list_members or whoami.",
      inputSchema: z.object({ id: z.string().min(1).describe("Opaque user id") }),
      outputSchema: memberOutput,
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guarded(async () => {
        const member = await deps.userInfo.member(principal.token, id);
        if (!member) return failure(`No member with id ${id}`);
        return structured(member, `${member.displayName} (${member.id})`);
      }),
  );

  return server;
}

function describeCaller(out: z.infer<typeof whoamiOutput>): string {
  const name = out.displayName ?? out.id;
  return `${name} — ${out.role}, via client ${out.clientId}; token expires ${out.tokenExpiresAt}`;
}

function structured(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Upstream trouble is reported as a tool error (the client can retry), never as a protocol failure. */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserInfoError) return failure(`user-info API: ${err.code}: ${err.message}`);
    throw err;
  }
}

/** whoami degrades gracefully: the principal alone is a valid answer when the user-info API is down. */
function swallowUpstream(err: unknown): Member | undefined {
  if (err instanceof UserInfoError) return undefined;
  throw err;
}
