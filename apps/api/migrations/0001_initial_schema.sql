CREATE TYPE "public"."crawl_status" AS ENUM('pending', 'discovering', 'crawling', 'done', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."fetch_status" AS ENUM('ok', 'failed', 'blocked', 'skipped_robots');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('error', 'warning', 'notice');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website_url" text NOT NULL,
	"site_key" text NOT NULL,
	"crawl_status" "crawl_status" DEFAULT 'pending' NOT NULL,
	"crawl_error_code" text,
	"crawl_error_message" text,
	"sitemap_url" text,
	"discovery_method" text,
	"pages_total" integer DEFAULT 0 NOT NULL,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"crawl_started_at" timestamp with time zone,
	"crawl_finished_at" timestamp with time zone,
	"crawl_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_pages_progress" CHECK ("clients"."pages_done" between 0 and "clients"."pages_total")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "keywords_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"term" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_keywords" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "page_keywords_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"page_id" uuid NOT NULL,
	"keyword_id" bigint NOT NULL,
	"score" real NOT NULL,
	"rank_order" smallint NOT NULL,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sitemap_position" integer NOT NULL,
	"fetch_status" "fetch_status" NOT NULL,
	"http_status" smallint,
	"final_url" text,
	"title" text,
	"meta_description" text,
	"h1" text,
	"word_count" integer,
	"lang" text,
	"response_ms" integer,
	"fetch_error" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_snapshots" (
	"page_keyword_id" bigint NOT NULL,
	"snapshot_date" date NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"position" smallint,
	CONSTRAINT "rank_snapshots_page_keyword_id_snapshot_date_pk" PRIMARY KEY("page_keyword_id","snapshot_date"),
	CONSTRAINT "rank_snapshots_position_range" CHECK ("rank_snapshots"."position" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "seo_issues" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seo_issues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"page_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"message" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_keywords" ADD CONSTRAINT "page_keywords_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_keywords" ADD CONSTRAINT "page_keywords_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD CONSTRAINT "rank_snapshots_page_keyword_id_page_keywords_id_fk" FOREIGN KEY ("page_keyword_id") REFERENCES "public"."page_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_user_site_key" ON "clients" USING btree ("user_id","site_key");--> statement-breakpoint
CREATE INDEX "clients_crawl_status_idx" ON "clients" USING btree ("crawl_status");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_term_key" ON "keywords" USING btree ("term");--> statement-breakpoint
CREATE INDEX "keywords_term_trgm_idx" ON "keywords" USING gin ("term" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "page_keywords_page_keyword_key" ON "page_keywords" USING btree ("page_id","keyword_id");--> statement-breakpoint
CREATE INDEX "page_keywords_keyword_id_idx" ON "page_keywords" USING btree ("keyword_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_client_url_key" ON "pages" USING btree ("client_id","url");--> statement-breakpoint
CREATE INDEX "pages_client_position_idx" ON "pages" USING btree ("client_id","sitemap_position");--> statement-breakpoint
CREATE INDEX "pages_url_trgm_idx" ON "pages" USING gin ("url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "rank_snapshots_pair_captured_idx" ON "rank_snapshots" USING btree ("page_keyword_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "seo_issues_page_code_key" ON "seo_issues" USING btree ("page_id","code");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");