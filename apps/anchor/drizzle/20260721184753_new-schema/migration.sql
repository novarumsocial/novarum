DROP INDEX "message_authorId_idx";--> statement-breakpoint
DROP INDEX "message_channelId_idx";--> statement-breakpoint
DROP INDEX "attachment_uploaderId_idx";--> statement-breakpoint
DROP INDEX "channel_guildId_idx";--> statement-breakpoint
DROP INDEX "channel_read_state_channelId_idx";--> statement-breakpoint
DROP INDEX "channel_read_state_userId_idx";--> statement-breakpoint
DROP INDEX "guild_invite_creatorId_idx";--> statement-breakpoint
DROP INDEX "guild_member_guildId_idx";--> statement-breakpoint
DROP INDEX "local_credential_userId_idx";--> statement-breakpoint
DROP INDEX "message_ping_messageId_idx";--> statement-breakpoint
ALTER TABLE "attachment" RENAME CONSTRAINT "attachment_uploaderId_fkey" TO "attachment_uploaderId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "attachment" RENAME CONSTRAINT "attachment_channelId_fkey" TO "attachment_channelId_channel_id_fkey";--> statement-breakpoint
ALTER TABLE "attachment" RENAME CONSTRAINT "attachment_messageId_fkey" TO "attachment_messageId_message_id_fkey";--> statement-breakpoint
ALTER TABLE "channel_read_state" RENAME CONSTRAINT "channel_read_state_userId_fkey" TO "channel_read_state_userId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "channel_read_state" RENAME CONSTRAINT "channel_read_state_channelId_fkey" TO "channel_read_state_channelId_channel_id_fkey";--> statement-breakpoint
ALTER TABLE "channel" RENAME CONSTRAINT "channel_guildId_fkey" TO "channel_guildId_guild_id_fkey";--> statement-breakpoint
ALTER TABLE "guild_invite" RENAME CONSTRAINT "guild_invite_guildId_fkey" TO "guild_invite_guildId_guild_id_fkey";--> statement-breakpoint
ALTER TABLE "guild_invite" RENAME CONSTRAINT "guild_invite_creatorId_fkey" TO "guild_invite_creatorId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "guild_member" RENAME CONSTRAINT "guild_member_guildId_fkey" TO "guild_member_guildId_guild_id_fkey";--> statement-breakpoint
ALTER TABLE "guild_member" RENAME CONSTRAINT "guild_member_userId_fkey" TO "guild_member_userId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "guild" RENAME CONSTRAINT "guild_ownerId_fkey" TO "guild_ownerId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "local_credential" RENAME CONSTRAINT "local_credential_userId_fkey" TO "local_credential_userId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "message_ping" RENAME CONSTRAINT "message_ping_messageId_fkey" TO "message_ping_messageId_message_id_fkey";--> statement-breakpoint
ALTER TABLE "message_ping" RENAME CONSTRAINT "message_ping_userId_fkey" TO "message_ping_userId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_channelId_fkey" TO "message_channelId_channel_id_fkey";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_authorId_fkey" TO "message_authorId_user_id_fkey";--> statement-breakpoint
ALTER TABLE "session" RENAME CONSTRAINT "session_userId_fkey" TO "session_userId_user_id_fkey";--> statement-breakpoint

-- backfilling the expiresAt column with a default value of 1 year from createdAt for existing rows
-- job done by 5.6 sol because idk sql im so sorry
-- ALTER TABLE "session" ADD COLUMN "expiresAt" timestamp(3) with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "expiresAt" timestamp(3) with time zone;
UPDATE "session" SET "expiresAt" = now() + interval '1 year';
ALTER TABLE "session" ALTER COLUMN "expiresAt" SET NOT NULL;

ALTER TABLE "session" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "emojis" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "federation_nonce" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "channel" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "guild" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "guild_member" ALTER COLUMN "joinedAt" SET DATA TYPE timestamp(3) with time zone USING "joinedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "guild_invite" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "homeserver_keys" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "channel_read_state" ALTER COLUMN "lastReadCreatedAt" SET DATA TYPE timestamp(3) with time zone USING "lastReadCreatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "guild_invite" ALTER COLUMN "expiresAt" SET DATA TYPE timestamp(3) with time zone USING "expiresAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "createdAt" SET DATA TYPE timestamp(3) with time zone USING "createdAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "deletedAt" SET DATA TYPE timestamp(3) with time zone USING "deletedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "emojis" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "emojis" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "channel" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "channel" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "homeserver_keys" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "homeserver_keys" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "guild" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "guild" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "size" SET DATA TYPE bigint USING "size"::bigint;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "updatedAt" SET DATA TYPE timestamp(3) with time zone USING "updatedAt"::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "channel" RENAME CONSTRAINT "channel_guildId_name_key" TO "channel_guildId_name_unique";--> statement-breakpoint
ALTER TABLE "federation_nonce" RENAME CONSTRAINT "federation_nonce_nonce_key" TO "federation_nonce_homeserver_nonce_unique";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_authorId_nonce_key" TO "message_authorId_nonce_unique";--> statement-breakpoint
ALTER TABLE "user" RENAME CONSTRAINT "user_username_homeserverName_key" TO "user_username_homeserver_unique";--> statement-breakpoint
ALTER TABLE "federation_nonce" DROP CONSTRAINT "federation_nonce_homeserver_nonce_unique";--> statement-breakpoint
ALTER TABLE "federation_nonce" ADD CONSTRAINT "federation_nonce_homeserver_nonce_unique" UNIQUE("homeserver","nonce");--> statement-breakpoint
CREATE INDEX "message_replyTo_idx" ON "message" ("replyTo");--> statement-breakpoint
CREATE INDEX "session_expiresAt_idx" ON "session" ("expiresAt");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_replyTo_message_id_fkey" FOREIGN KEY ("replyTo") REFERENCES "message"("id") ON DELETE SET NULL;
