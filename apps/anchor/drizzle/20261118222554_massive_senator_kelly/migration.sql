ALTER TABLE "message" ADD COLUMN "pinnedAt" timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "message_channelId_pinnedAt_idx" ON "message" ("channelId","pinnedAt");