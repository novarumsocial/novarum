CREATE TABLE "channel_member" (
	"channelId" text,
	"userId" text,
	"closed" boolean DEFAULT false NOT NULL,
	"joinedAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_member_pkey" PRIMARY KEY("channelId","userId")
);
--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "dmKey" text;--> statement-breakpoint
ALTER TABLE "channel" ALTER COLUMN "guildId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel" ALTER COLUMN "position" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_dmKey_key" UNIQUE("dmKey");--> statement-breakpoint
CREATE INDEX "channel_member_userId_idx" ON "channel_member" ("userId");--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_channelId_channel_id_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_guild_or_dm_check" CHECK ("guildId" IS NOT NULL OR "type" IN ('DM', 'GROUP_DM'));