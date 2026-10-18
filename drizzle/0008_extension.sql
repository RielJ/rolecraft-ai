-- Chrome extension tables (docs/plans/chrome-extension.md). No hb_sync grants on purpose: sync can
-- neither read nor write them (drizzle/0004_sync_role.sql). test/extension-db.test.ts pins the constraints.
CREATE TABLE "application_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"category" text NOT NULL,
	"typed_value" jsonb NOT NULL,
	"display_text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_preferences_category" CHECK (category IN ('given_name', 'family_name', 'full_name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'website', 'references', 'referral_source', 'work_authorization', 'requires_sponsorship', 'notice_period', 'start_date', 'willing_to_relocate', 'work_arrangement', 'willing_to_travel', 'gender', 'race_ethnicity', 'veteran_status', 'disability_status')),
	CONSTRAINT "application_preferences_typed_value" CHECK (jsonb_typeof(typed_value) = 'object' AND typed_value->>'valueType' IN ('text', 'yesNo', 'date', 'choice')),
	CONSTRAINT "application_preferences_display_text" CHECK (length(btrim(display_text)) > 0)
);
--> statement-breakpoint
CREATE TABLE "application_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"apply_url" text NOT NULL,
	"apply_url_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_pairing_id" uuid,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_sessions_status" CHECK (status IN ('pending', 'claimed', 'completed', 'expired')),
	CONSTRAINT "application_sessions_pending" CHECK (status <> 'pending' OR claimed_at IS NULL),
	CONSTRAINT "application_sessions_claimed" CHECK (status NOT IN ('claimed', 'completed') OR claimed_at IS NOT NULL),
	CONSTRAINT "application_sessions_completed" CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
	CONSTRAINT "application_sessions_pairing" CHECK (claimed_by_pairing_id IS NULL OR claimed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "extension_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"extension_origin" text,
	"code_hash" text NOT NULL,
	"code_expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_pairings_claim" CHECK ((claimed_at IS NULL) = (token_hash IS NULL)),
	CONSTRAINT "extension_pairings_claim_origin" CHECK ((claimed_at IS NULL) = (extension_origin IS NULL)),
	CONSTRAINT "extension_pairings_used" CHECK (last_used_at IS NULL OR claimed_at IS NOT NULL),
	CONSTRAINT "extension_pairings_origin" CHECK (extension_origin IS NULL OR extension_origin ~ '^chrome-extension://[a-p]{32}$')
);
--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_preferences" ADD CONSTRAINT "application_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_preferences" ADD CONSTRAINT "application_preferences_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sessions" ADD CONSTRAINT "application_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sessions" ADD CONSTRAINT "application_sessions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sessions" ADD CONSTRAINT "application_sessions_claimed_by_pairing_id_extension_pairings_id_fk" FOREIGN KEY ("claimed_by_pairing_id") REFERENCES "public"."extension_pairings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_pairings" ADD CONSTRAINT "extension_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_preferences_global" ON "application_preferences" USING btree ("user_id","category") WHERE opportunity_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "application_preferences_job" ON "application_preferences" USING btree ("user_id","opportunity_id","category") WHERE opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "application_preferences_opportunity" ON "application_preferences" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_sessions_one_live" ON "application_sessions" USING btree ("user_id") WHERE status IN ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "application_sessions_opportunity" ON "application_sessions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_pairings_code" ON "extension_pairings" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_pairings_token" ON "extension_pairings" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "extension_pairings_user" ON "extension_pairings" USING btree ("user_id","created_at" DESC NULLS LAST);