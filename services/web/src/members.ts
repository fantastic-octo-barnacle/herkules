/**
 * Display names for user ids, resolved once per id for the life of the
 * QueryClient. Pages of the audit log and allowlist name the same few people
 * over and over; only ids never seen before hit `api.membersById`.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { Api, Member } from "./api.ts";

const key = (id: string) => ["member", id] as const;

export async function resolveMembers(
  queryClient: QueryClient,
  api: Api,
  ids: readonly string[],
): Promise<Member[]> {
  const wanted = [...new Set(ids)];
  const unknown = wanted.filter((id) => queryClient.getQueryData<Member>(key(id)) === undefined);
  if (unknown.length) {
    for (const m of await api.membersById(unknown)) queryClient.setQueryData(key(m.id), m);
  }
  return wanted.flatMap((id) => queryClient.getQueryData<Member>(key(id)) ?? []);
}
