CREATE TABLE "guild_ban" (
	"guildId" text,
	"userId" text,
	"reason" text,
	"bannedById" text,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_ban_pkey" PRIMARY KEY("guildId","userId")
);
--> statement-breakpoint
ALTER TABLE "guild_ban" ADD CONSTRAINT "guild_ban_guildId_guild_id_fkey" FOREIGN KEY ("guildId") REFERENCES "guild"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guild_ban" ADD CONSTRAINT "guild_ban_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guild_ban" ADD CONSTRAINT "guild_ban_bannedById_user_id_fkey" FOREIGN KEY ("bannedById") REFERENCES "user"("id") ON DELETE SET NULL;