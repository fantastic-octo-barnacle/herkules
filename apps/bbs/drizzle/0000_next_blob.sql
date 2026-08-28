CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"article_id" text,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_ai" (
	"article_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"context_hash" text,
	"overview_json" jsonb,
	"kb_json" jsonb,
	"images_json" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"generated_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_entities" (
	"article_id" text NOT NULL,
	"entity_key" text NOT NULL,
	CONSTRAINT "article_entities_article_id_entity_key_pk" PRIMARY KEY("article_id","entity_key")
);
--> statement-breakpoint
CREATE TABLE "article_images" (
	"id" text PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"position" integer NOT NULL,
	"caption" text,
	"image_kind" text,
	"image_text" text
);
--> statement-breakpoint
CREATE TABLE "article_links" (
	"id" text PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"position" integer NOT NULL,
	"target_article_id" text
);
--> statement-breakpoint
CREATE TABLE "article_search" (
	"article_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"tags" text NOT NULL,
	"introduction" text NOT NULL,
	"body_text" text NOT NULL,
	"document" text NOT NULL,
	CONSTRAINT "article_search_document_aligned" CHECK (length("article_search"."document") = length("article_search"."title") + length("article_search"."author") + length("article_search"."tags") + length("article_search"."introduction") + length("article_search"."body_text") + 4)
);
--> statement-breakpoint
CREATE TABLE "article_tags" (
	"article_id" text NOT NULL,
	"tag" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"group_name" text GENERATED ALWAYS AS (split_part(tag, '/', 1)) STORED NOT NULL,
	CONSTRAINT "article_tags_article_id_tag_pk" PRIMARY KEY("article_id","tag")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"source_article_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"url_hash" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"published_at" timestamp (3) with time zone,
	"discovered_at" timestamp (3) with time zone NOT NULL,
	"fetched_at" timestamp (3) with time zone,
	"listing_position" integer DEFAULT 0 NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"introduction" text,
	"content_format" text,
	"content_raw" text,
	"content_html" text,
	"body_text" text,
	"content_hash" text,
	"parser_version" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"last_error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"refresh_requested_at" timestamp (3) with time zone,
	"content_changed_at" timestamp (3) with time zone,
	"title_season" text,
	"title_team" text,
	"title_topic" text,
	"title_labels" text[]
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"source_path" text NOT NULL,
	"source_bytes" integer NOT NULL,
	"ok" boolean NOT NULL,
	"noop" boolean DEFAULT false NOT NULL,
	"tables" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"render_version" text NOT NULL,
	"normalize_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_entities" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"article_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_search" (
	"article_id" text PRIMARY KEY NOT NULL,
	"tldr" text NOT NULL,
	"problem" text NOT NULL,
	"approach" text NOT NULL,
	"components" text NOT NULL,
	"parameters" text NOT NULL,
	"decisions" text NOT NULL,
	"pitfalls" text NOT NULL,
	"entities" text NOT NULL,
	"keywords" text NOT NULL,
	"captions" text NOT NULL,
	"document" text NOT NULL,
	CONSTRAINT "kb_search_document_aligned" CHECK (length("kb_search"."document") = length("kb_search"."tldr") + length("kb_search"."problem") + length("kb_search"."approach") + length("kb_search"."components") + length("kb_search"."parameters") + length("kb_search"."decisions") + length("kb_search"."pitfalls") + length("kb_search"."entities") + length("kb_search"."keywords") + length("kb_search"."captions") + 9)
);
--> statement-breakpoint
CREATE TABLE "poll_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"listed" integer DEFAULT 0 NOT NULL,
	"discovered" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"refreshed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_guard_state" (
	"source_id" text PRIMARY KEY NOT NULL,
	"state_json" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"site_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"backfill_next_page" integer DEFAULT 2 NOT NULL,
	"backfill_completed_at" timestamp (3) with time zone,
	"initialized_at" timestamp (3) with time zone,
	"last_checked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_ai" ADD CONSTRAINT "article_ai_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_entities" ADD CONSTRAINT "article_entities_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_entities" ADD CONSTRAINT "article_entities_entity_key_kb_entities_key_fk" FOREIGN KEY ("entity_key") REFERENCES "public"."kb_entities"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_images" ADD CONSTRAINT "article_images_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_target_article_id_articles_id_fk" FOREIGN KEY ("target_article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_search" ADD CONSTRAINT "article_search_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_search" ADD CONSTRAINT "kb_search_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_runs" ADD CONSTRAINT "poll_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "article_ai_status_idx" ON "article_ai" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "article_ai_generated_idx" ON "article_ai" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "article_entities_entity_idx" ON "article_entities" USING btree ("entity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "article_images_article_url_uq" ON "article_images" USING btree ("article_id","url");--> statement-breakpoint
CREATE INDEX "article_images_article_pos_idx" ON "article_images" USING btree ("article_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "article_links_article_url_uq" ON "article_links" USING btree ("article_id","url");--> statement-breakpoint
CREATE INDEX "article_links_article_pos_idx" ON "article_links" USING btree ("article_id","position");--> statement-breakpoint
CREATE INDEX "article_search_document_trgm" ON "article_search" USING gin ("document" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "article_tags_tag_idx" ON "article_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "article_tags_group_idx" ON "article_tags" USING btree ("group_name");--> statement-breakpoint
CREATE INDEX "article_tags_article_pos_idx" ON "article_tags" USING btree ("article_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_source_article_uq" ON "articles" USING btree ("source_id","source_article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_source_url_uq" ON "articles" USING btree ("source_id","url_hash");--> statement-breakpoint
CREATE INDEX "articles_status_idx" ON "articles" USING btree ("source_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "articles_feed_idx" ON "articles" USING btree (coalesce("published_at", "discovered_at") DESC,"listing_position" ASC,"id" DESC) WHERE "articles"."status" = 'fetched';--> statement-breakpoint
CREATE INDEX "articles_canonical_url_idx" ON "articles" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "import_runs_started_idx" ON "import_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_entities_count_idx" ON "kb_entities" USING btree ("article_count" DESC NULLS LAST,"name");--> statement-breakpoint
CREATE INDEX "kb_search_document_trgm" ON "kb_search" USING gin ("document" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "poll_runs_started_idx" ON "poll_runs" USING btree ("source_id","started_at" DESC NULLS LAST);