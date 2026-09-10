import type { Library } from "../library/index.ts";
import type { Cursor } from "../library/types.ts";
import type { BotCommand, SearchAction } from "./command.ts";
import {
  SEARCH_PAGE_SIZE,
  presentHelp,
  presentInvalid,
  presentLatest,
  presentSearch,
  presentStatus,
  presentUnknown,
} from "./present.ts";
import type { FrozenPayload } from "./present.ts";

export interface RespondDeps {
  readonly library: Library;
  readonly appOrigin: string;
  readonly chatType: "p2p" | "group";
  readonly nonce: () => string;
}

/** Runs a parsed command against the shared Library and freezes the card to send. */
export async function respond(command: BotCommand, deps: RespondDeps): Promise<FrozenPayload> {
  switch (command.kind) {
    case "search":
      return respondSearch(
        {
          v: 1,
          cmd: "search",
          q: command.query,
          scope: command.scope,
          trail: [],
          chatType: deps.chatType,
          nonce: "",
        },
        deps,
      );
    case "latest":
      return presentLatest(
        (await deps.library.articles({ limit: SEARCH_PAGE_SIZE })).items,
        deps.appOrigin,
      );
    case "status":
      return presentStatus(await deps.library.status(), deps.appOrigin);
    case "unknown":
      return presentUnknown(command.name);
    case "invalid":
      return presentInvalid(command.reason);
    case "help":
    case "ignore":
      return presentHelp(deps.chatType);
  }
}

/** Renders the page a card button asked for; a stale cursor falls back to the first page. */
export async function respondSearch(
  action: SearchAction,
  deps: RespondDeps,
): Promise<FrozenPayload> {
  const cursor = action.trail.at(-1);
  let trail = action.trail;
  let page;
  try {
    page = await deps.library.search({
      q: action.q,
      scope: action.scope,
      cursor: cursor ? (cursor as Cursor) : undefined,
      limit: SEARCH_PAGE_SIZE,
    });
  } catch (error) {
    if (!cursor || !isInvalidCursor(error)) throw error;
    trail = [];
    page = await deps.library.search({ q: action.q, scope: action.scope, limit: SEARCH_PAGE_SIZE });
  }
  return presentSearch({
    query: action.q,
    scope: action.scope,
    trail,
    chatType: action.chatType,
    page,
    appOrigin: deps.appOrigin,
    nonce: deps.nonce(),
  });
}

function isInvalidCursor(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "invalid_cursor"
  );
}
