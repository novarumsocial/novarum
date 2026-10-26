CREATE TABLE "channel_canvas" (
	"channelId" text PRIMARY KEY,
	"content" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updatedById" text,
	"updatedAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_canvas" ADD CONSTRAINT "channel_canvas_channelId_channel_id_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel_canvas" ADD CONSTRAINT "channel_canvas_updatedById_user_id_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL;