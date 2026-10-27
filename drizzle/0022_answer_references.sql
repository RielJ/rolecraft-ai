CREATE TABLE "answer_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_references_question" CHECK (length(btrim(question)) BETWEEN 5 AND 500),
	CONSTRAINT "answer_references_body" CHECK (length(btrim(body)) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "answer_references" ADD CONSTRAINT "answer_references_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_references" ADD CONSTRAINT "answer_references_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_references_source_question" ON "answer_references" USING btree ("user_id","opportunity_id","question_key");--> statement-breakpoint
CREATE INDEX "answer_references_lookup" ON "answer_references" USING btree ("user_id","question_key");