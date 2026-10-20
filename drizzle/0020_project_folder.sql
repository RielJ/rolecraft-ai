ALTER TABLE "profile_items" ADD COLUMN "folder" text;--> statement-breakpoint
ALTER TABLE "profile_items" ADD CONSTRAINT "profile_items_folder" CHECK (kind <> 'cv' OR folder IS NULL);