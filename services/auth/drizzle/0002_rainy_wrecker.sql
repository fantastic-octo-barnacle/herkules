CREATE TABLE "feishu_allowlist" (
	"tenant_key" text NOT NULL,
	"open_id" text NOT NULL,
	"note" text,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_allowlist_tenant_key_open_id_pk" PRIMARY KEY("tenant_key","open_id")
);
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "githubLogin" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "githubId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "feishuTenantKey" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "feishuOpenId" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "githubConnectionOffered" boolean DEFAULT false;