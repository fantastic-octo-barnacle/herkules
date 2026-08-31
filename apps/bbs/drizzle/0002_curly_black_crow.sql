CREATE TABLE "bot_article_decisions" (
	"source_id" text NOT NULL,
	"source_article_id" text NOT NULL,
	"status" text NOT NULL,
	"decided_at" timestamp (3) with time zone NOT NULL,
	"assignment_day" date,
	"immediate_slot" integer,
	"article_id" text,
	"title" text,
	"excerpt" text,
	"published_at" timestamp (3) with time zone,
	"article_link" text,
	"delivery_id" text,
	"digest_delivery_id" text,
	"digest_ordinal" integer,
	CONSTRAINT "bot_article_decisions_source_id_source_article_id_pk" PRIMARY KEY("source_id","source_article_id"),
	CONSTRAINT "bot_decisions_status_ck" CHECK ("bot_article_decisions"."status" in ('baseline', 'ineligible_null_publication', 'ineligible_pre_activation', 'immediate', 'overflow')),
	CONSTRAINT "bot_decisions_slot_ck" CHECK ("bot_article_decisions"."immediate_slot" is null or "bot_article_decisions"."immediate_slot" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "bot_days" (
	"assignment_day" date PRIMARY KEY NOT NULL,
	"sealed_at" timestamp (3) with time zone,
	"digest_delivery_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"logical_key" text NOT NULL,
	"chat_id" text NOT NULL,
	"reply_to_message_id" text,
	"msg_type" text NOT NULL,
	"content" text NOT NULL,
	"payload_hash" text NOT NULL,
	"uuid" text NOT NULL,
	"scheduled_at" timestamp (3) with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_token" text,
	"leased_until" timestamp (3) with time zone,
	"next_attempt_at" timestamp (3) with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"feishu_message_id" text,
	"last_error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "bot_deliveries_kind_ck" CHECK ("bot_deliveries"."kind" in ('article', 'digest', 'reply')),
	CONSTRAINT "bot_deliveries_state_ck" CHECK ("bot_deliveries"."state" in ('pending', 'leased', 'sent', 'cancelled', 'permanent'))
);
--> statement-breakpoint
CREATE TABLE "bot_delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"outcome" text,
	"code" text,
	CONSTRAINT "bot_attempts_outcome_ck" CHECK ("bot_delivery_attempts"."outcome" is null or "bot_delivery_attempts"."outcome" in ('sent', 'not_sent', 'ambiguous', 'permanent'))
);
--> statement-breakpoint
CREATE TABLE "bot_inbound_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"raw_content_type" text NOT NULL,
	"content" text NOT NULL,
	"created_at_feishu" timestamp (3) with time zone NOT NULL,
	"admitted_at" timestamp (3) with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_token" text,
	"leased_until" timestamp (3) with time zone,
	"reply_delivery_id" text,
	"last_error" text,
	CONSTRAINT "bot_inbound_chat_type_ck" CHECK ("bot_inbound_receipts"."chat_type" in ('p2p', 'group')),
	CONSTRAINT "bot_inbound_state_ck" CHECK ("bot_inbound_receipts"."state" in ('pending', 'leased', 'planned', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "bot_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"activated_at" timestamp (3) with time zone NOT NULL,
	"announcement_chat_id" text NOT NULL,
	"last_reconciled_at" timestamp (3) with time zone,
	CONSTRAINT "bot_state_singleton" CHECK ("bot_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "bot_article_decisions" ADD CONSTRAINT "bot_article_decisions_assignment_day_bot_days_assignment_day_fk" FOREIGN KEY ("assignment_day") REFERENCES "public"."bot_days"("assignment_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_article_decisions" ADD CONSTRAINT "bot_article_decisions_delivery_id_bot_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."bot_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_article_decisions" ADD CONSTRAINT "bot_article_decisions_digest_delivery_id_bot_deliveries_id_fk" FOREIGN KEY ("digest_delivery_id") REFERENCES "public"."bot_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_days" ADD CONSTRAINT "bot_days_digest_delivery_id_bot_deliveries_id_fk" FOREIGN KEY ("digest_delivery_id") REFERENCES "public"."bot_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_delivery_attempts" ADD CONSTRAINT "bot_delivery_attempts_delivery_id_bot_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."bot_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_inbound_receipts" ADD CONSTRAINT "bot_inbound_receipts_reply_delivery_id_bot_deliveries_id_fk" FOREIGN KEY ("reply_delivery_id") REFERENCES "public"."bot_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_decisions_day_slot_uq" ON "bot_article_decisions" USING btree ("assignment_day","immediate_slot") WHERE "bot_article_decisions"."immediate_slot" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_decisions_delivery_uq" ON "bot_article_decisions" USING btree ("delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_decisions_digest_ordinal_uq" ON "bot_article_decisions" USING btree ("digest_delivery_id","digest_ordinal") WHERE "bot_article_decisions"."digest_delivery_id" is not null;--> statement-breakpoint
CREATE INDEX "bot_decisions_digest_members_idx" ON "bot_article_decisions" USING btree ("assignment_day","status","digest_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_days_digest_delivery_uq" ON "bot_days" USING btree ("digest_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_deliveries_logical_key_uq" ON "bot_deliveries" USING btree ("logical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_deliveries_uuid_uq" ON "bot_deliveries" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX "bot_deliveries_due_idx" ON "bot_deliveries" USING btree ("state","next_attempt_at","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_attempts_delivery_no_uq" ON "bot_delivery_attempts" USING btree ("delivery_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_attempts_lease_token_uq" ON "bot_delivery_attempts" USING btree ("lease_token");--> statement-breakpoint
CREATE INDEX "bot_attempts_unfinished_idx" ON "bot_delivery_attempts" USING btree ("finished_at","started_at");--> statement-breakpoint
CREATE INDEX "bot_inbound_pending_idx" ON "bot_inbound_receipts" USING btree ("state","admitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_inbound_reply_delivery_uq" ON "bot_inbound_receipts" USING btree ("reply_delivery_id");