ALTER TABLE "channel" ADD COLUMN "ownerId" text;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "iconUrl" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "system" jsonb;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_ownerId_user_id_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL;