# Frame: Feishu bot — 2026-08-30

## Problem

RM 文库 needs an internal Feishu bot that brings new, searchable corpus content into the
team's chats without flooding them. The bot must notify one announcement group when a newly
published RoboMaster post becomes available in BBS, cap immediate notifications at three per
Hong Kong calendar day, combine the overflow the next morning, and answer deterministic BBS
searches from any internal chat or direct message where the app is installed. Delivery state
must survive restarts and outages.

## Prior art

- `@herkules/bbs` already owns the corpus, crawler, Postgres schema, deterministic search, REST
  API, MCP tools, and the shared `Library` query boundary. The crawler checks page 1 every ten
  minutes and records `publishedAt`, `discoveredAt`, `fetchedAt`, and stable source article IDs.
  The deployment already runs separate commands from one BBS image. Extend this instead of
  creating another product boundary.
- No Feishu bot, Lark bot, or Feishu webhook implementation exists elsewhere under `~/dev`.
- The retired `rm-wenku` event bus used an in-process Tokio broadcast channel for live status.
  It was transient and could lose events across restarts, so it is not suitable for delivery and
  will not be ported.
- `projects/nexus` contains a durable SQLite outbox pattern. It is useful design evidence, but its
  Rust code and sync domain do not transfer to this TypeScript/Postgres feature.
- A Feishu custom-bot webhook covers outbound notifications but not the required inbound search
  interaction. It is therefore an incomplete fit.
- Feishu's official Node SDK supports app bots, message events, outbound messages, and WebSocket
  long connections. Its channel entry point also handles connection lifecycle, normalized
  messages, mentions, and direct messages. Use it rather than implementing the Feishu protocol.

## Decision

Add a `bot` command to `@herkules/bbs` and run it as a single-replica `bbs-bot` Compose service
from the existing BBS image. It is a separate process from both the HTTP server and crawler. It
uses the BBS `Library` directly for search and a bot-owned Postgres store for scheduling and
delivery state. It takes its own Postgres advisory lock so an accidental second replica exits
before receiving or sending messages.

Use a Feishu enterprise self-built app and the official `@larksuiteoapi/node-sdk` WebSocket long
connection. Do not add a public event callback route. Group messages require an `@bot` mention;
direct messages do not. The bot accepts `搜索 <terms>` and `search <terms>` in groups, treats
ordinary direct-message text as a search query, and provides `help`. Search returns the same top
five deterministic results as `Library.search`, formatted with title, excerpt, and BBS article
link. The app may answer in any internal chat where it is installed. It does not map Feishu users
to Herkules identities because BBS reads are public.

Proactive notifications go to one configured announcement chat only. On first successful boot,
the bot persists an activation timestamp and treats the existing corpus as the baseline. A post
is eligible only when its source publication time is after that activation timestamp and BBS has
successfully fetched and indexed it. Backfill is already complete; old backfill, refreshes,
content edits, and later AI output do not create notification events.

Each `Asia/Hong_Kong` calendar day permits three immediate article notifications. Further
eligible articles enter that day's overflow. At 09:00 the following day, the bot sends one digest
for the previous day's overflow. That digest does not consume the new day's immediate quota. An
empty digest sends nothing. If the bot is offline at 09:00, it sends the missed digest once after
recovery.

Persist eligibility, attempts, Feishu message IDs, digest membership, and completion in BBS
Postgres. Delivery keys use stable `(source_id, source_article_id)` values rather than BBS article
ULIDs, because the deprecated full import can replace the corpus. Bot tables are app-owned and
must not join the imported-table truncation list. Use a stable Feishu message `uuid` on retries;
Feishu suppresses the same UUID for one hour. Prefer delivery after ambiguous failures, accepting
that a rare duplicate remains possible after an outage longer than Feishu's deduplication window.

The scheduler is an application loop over an injectable clock, not system cron. Feishu transport,
time, and persistence sit behind narrow interfaces so notification and recovery behavior can be
tested without a live tenant.

Alternatives considered:

- A separate `apps/feishu-bot` consuming anonymous REST search would preserve a network boundary,
  but it would still need durable BBS-owned notification state or a new write API. That adds a
  workspace, image, and contract without separating independently changing domain policy.
- A public Feishu HTTP callback would support inbound commands, but it adds Caddy routing,
  verification, encryption, and public endpoint operation that one internal, single-replica bot
  does not need.
- A custom webhook plus Feishu automation could send notifications and relay commands, but it
  splits one bot across code and tenant-side workflows and is harder to test and operate.

## In scope / Out of scope

In scope:

- One internal Feishu self-built application using a WebSocket long connection.
- Search in installed internal groups and direct messages.
- One configured group for proactive notifications.
- Three immediate notifications per Hong Kong day and one next-morning overflow digest.
- Durable activation, quota, digest, retry, and deduplication state.
- Recovery of a missed digest and retry of failed or ambiguous sends.
- Process supervision, advisory locking, structured logs, configuration examples, and setup docs.
- Fake-clock, fake-transport, persistence, restart, and command tests.

Out of scope:

- External Feishu groups or Lark tenants.
- Per-chat `subscribe` and `unsubscribe`, multiple notification destinations, or per-user settings.
- Custom-bot webhooks, public Feishu callback endpoints, and interactive card callbacks.
- LLM answers, conversational retrieval, query rewriting, or a new BBS search mode.
- Notifications for the existing corpus, backfill, article edits, refreshes, or AI/KB completion.
- Feishu-to-Herkules identity mapping or authorization of public BBS reads.
- A generic notification framework, queue broker, or cross-product outbox package.
- Exactly-once delivery beyond Feishu's one-hour UUID deduplication window.
- Changes to RoboMaster request limits, crawler discovery cadence, or source-blocking policy.

## Kill criterion

If the intended tenant cannot deliver `im.message.receive_v1` events from both installed internal
group chats and direct messages to the self-built app through Feishu's WebSocket long connection,
stop and re-frame the transport. Do not silently add a custom webhook, public callback, or
tenant-side automation workflow.

## Done predicate

`vp run ready` passes, and an integration test over real Postgres-compatible persistence, a fake
clock, and a fake Feishu transport proves all of the following:

1. First boot records the baseline and sends nothing for the existing corpus.
2. Four posts published after activation and successfully fetched on one Hong Kong day produce
   exactly three immediate sends; the fourth appears exactly once in the next 09:00 digest, which
   does not reduce the new day's immediate quota.
3. Restarting between eligibility, send attempts, and completion loses no item. Reusing a stable
   UUID suppresses retry duplicates inside the supported window, and a missed 09:00 run is sent
   once on recovery.
4. A mentioned group command and an ordinary direct message return the same first five article IDs
   as `Library.search`, with title, excerpt, and link; an unmentioned group message produces no
   response.
5. In the configured Feishu tenant, the deployed single `bbs-bot` container connects without a
   public callback endpoint, answers one live group search and one live direct-message search, and
   sends a test notification only to the configured announcement group.
