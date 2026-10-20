ALTER TABLE "profile_items" ADD COLUMN "project_role_read" text;--> statement-breakpoint
ALTER TABLE "profile_items" ADD COLUMN "project_role_choice" text;--> statement-breakpoint
ALTER TABLE "profile_items" ADD CONSTRAINT "profile_items_project_role_read" CHECK (project_role_read IN ('own', 'contribution'));--> statement-breakpoint
ALTER TABLE "profile_items" ADD CONSTRAINT "profile_items_project_role_choice" CHECK (project_role_choice IN ('own', 'contribution'));