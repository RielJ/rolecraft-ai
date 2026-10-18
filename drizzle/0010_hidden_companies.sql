CREATE TABLE "hidden_companies" (
	"user_id" uuid NOT NULL,
	"company_key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hidden_companies_user_id_company_key_pk" PRIMARY KEY("user_id","company_key")
);
--> statement-breakpoint
ALTER TABLE "hidden_companies" ADD CONSTRAINT "hidden_companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;