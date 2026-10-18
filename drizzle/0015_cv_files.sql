CREATE TABLE "cv_files" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cv_files_content_type" CHECK (content_type = 'application/pdf'),
	CONSTRAINT "cv_files_size" CHECK (size BETWEEN 1 AND 5242880),
	CONSTRAINT "cv_files_data_size" CHECK (octet_length(data) = size)
);
--> statement-breakpoint
ALTER TABLE "cv_files" ADD CONSTRAINT "cv_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;