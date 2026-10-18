CREATE TABLE "user_skills" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_skills_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "user_skills_kind" CHECK (kind IN ('added', 'hidden')),
	CONSTRAINT "user_skills_name" CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;