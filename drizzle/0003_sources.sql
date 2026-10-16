CREATE TABLE "job_listings" (
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"listing_url" text NOT NULL,
	"is_primary" boolean NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	CONSTRAINT "job_listings_source_id_external_id_pk" PRIMARY KEY("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"board" text,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"keywords" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_status" text,
	"last_count" integer,
	"last_ok_count" integer,
	"last_dropped" integer,
	"last_error" text,
	CONSTRAINT "sources_user_kind_board" UNIQUE NULLS NOT DISTINCT("user_id","kind","board"),
	CONSTRAINT "sources_kind" CHECK (kind IN ('jobicy', 'himalayas', 'remoteok', 'weworkremotely', 'remotive', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable')),
	CONSTRAINT "sources_last_status" CHECK (last_status IS NULL OR last_status IN ('ok', 'failed', 'rate_limited', 'suspicious_empty', 'skipped')),
	CONSTRAINT "sources_board" CHECK ((kind IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable')) = (board IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "job_listings" ADD CONSTRAINT "job_listings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_listings" ADD CONSTRAINT "job_listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_listings" ADD CONSTRAINT "job_listings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_listings_one_primary" ON "job_listings" USING btree ("job_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "job_listings_job" ON "job_listings" USING btree ("job_id");