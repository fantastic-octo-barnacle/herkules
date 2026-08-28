CREATE TABLE "corpus_versions" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"render_version" text NOT NULL,
	"normalize_version" text NOT NULL,
	"title_version" text NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "corpus_versions_singleton" CHECK ("corpus_versions"."id" = 1)
);
