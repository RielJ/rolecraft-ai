CREATE TABLE "eligibility_overrides" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_drops" (
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"url" text NOT NULL,
	"reason" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "role_drops_source_id_external_id_pk" PRIMARY KEY("source_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "eligibility_overrides" ADD CONSTRAINT "eligibility_overrides_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_overrides" ADD CONSTRAINT "eligibility_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_drops" ADD CONSTRAINT "role_drops_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_drops" ADD CONSTRAINT "role_drops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_drops_reason" ON "role_drops" USING btree ("user_id","reason","seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_excluded" ON "jobs" USING btree ("user_id","first_seen_at" DESC NULLS LAST) WHERE eligibility = 'excluded' AND closed_at IS NULL;