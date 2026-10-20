CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"start_text" text,
	"end_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_title" CHECK (length(btrim(title)) > 0),
	CONSTRAINT "roles_company" CHECK (length(btrim(company)) > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_calls" DROP CONSTRAINT "ai_calls_purpose";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind";--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_item_id_profile_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."profile_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_item" ON "roles" USING btree ("item_id","position");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_purpose" CHECK (purpose IN ('split', 'eligibility', 'questions', 'draft', 'github', 'roles'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind" CHECK (kind IN ('refresh', 'split', 'draft', 'suggest_questions', 'github_read', 'roles_read'));