DO $$
BEGIN
  IF to_regclass('public."user"') IS NOT NULL THEN
    RAISE NOTICE 'Tables already exist, skipping migration.';
    RETURN;
  END IF;

  CREATE TABLE "attachment" (
  	"channelId" text NOT NULL,
  	"contentType" text NOT NULL,
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"filename" text NOT NULL,
  	"id" text PRIMARY KEY,
  	"messageId" text,
  	"objectKey" text NOT NULL CONSTRAINT "attachment_objectKey_key" UNIQUE,
  	"size" integer NOT NULL,
  	"status" text DEFAULT 'PENDING' NOT NULL,
  	"uploaderId" text NOT NULL
  );
  
  CREATE TABLE "channel" (
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"guildId" text NOT NULL,
  	"id" text PRIMARY KEY,
  	"name" text NOT NULL,
  	"position" integer NOT NULL,
  	"type" text DEFAULT 'TEXT' NOT NULL,
  	"updatedAt" timestamp with time zone NOT NULL,
  	CONSTRAINT "channel_guildId_name_key" UNIQUE("guildId","name")
  );
  
  CREATE TABLE "channel_read_state" (
  	"channelId" text,
  	"lastReadCreatedAt" timestamp with time zone NOT NULL,
  	"lastReadMessageId" text NOT NULL,
  	"userId" text,
  	CONSTRAINT "channel_read_state_pkey" PRIMARY KEY("userId","channelId")
  );
  
  CREATE TABLE "emojis" (
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"id" serial PRIMARY KEY,
  	"name" text NOT NULL,
  	"unicode" text NOT NULL CONSTRAINT "emojis_unicode_key" UNIQUE,
  	"updatedAt" timestamp with time zone NOT NULL,
  	"url" text NOT NULL
  );
  
  CREATE TABLE "federation_nonce" (
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"homeserver" text NOT NULL,
  	"id" text PRIMARY KEY,
  	"nonce" text NOT NULL CONSTRAINT "federation_nonce_nonce_key" UNIQUE
  );
  
  CREATE TABLE "guild" (
  	"avatarUrl" text,
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"description" text,
  	"id" text PRIMARY KEY,
  	"name" text NOT NULL,
  	"ownerId" text NOT NULL,
  	"updatedAt" timestamp with time zone NOT NULL,
  	"extAnchorDown" boolean
  );
  
  CREATE TABLE "guild_invite" (
  	"code" text NOT NULL CONSTRAINT "guild_invite_code_key" UNIQUE,
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"expiresAt" timestamp with time zone,
  	"guildId" text NOT NULL,
  	"id" text PRIMARY KEY,
  	"creatorId" text NOT NULL
  );
  
  CREATE TABLE "guild_member" (
  	"guildId" text,
  	"joinedAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"role" text DEFAULT 'MEMBER' NOT NULL,
  	"userId" text,
  	CONSTRAINT "guild_member_pkey" PRIMARY KEY("guildId","userId")
  );
  
  CREATE TABLE "homeserver_keys" (
  	"active" boolean DEFAULT true NOT NULL,
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"homeserver" text NOT NULL,
  	"id" text PRIMARY KEY,
  	"privateKeyFilename" text NOT NULL,
  	"publicKey" text NOT NULL,
  	"updatedAt" timestamp with time zone NOT NULL
  );
  
  CREATE TABLE "local_credential" (
  	"email" text NOT NULL CONSTRAINT "local_credential_email_key" UNIQUE,
  	"passwordHash" text NOT NULL,
  	"userId" text PRIMARY KEY
  );
  
  CREATE TABLE "message" (
  	"authorId" text NOT NULL,
  	"channelId" text NOT NULL,
  	"content" text NOT NULL,
  	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  	"deletedAt" timestamp with time zone,
  	"id" text PRIMARY KEY,
  	"nonce" text NOT NULL,
  	"updatedAt" timestamp with time zone NOT NULL,
  	"replyTo" text,
  	CONSTRAINT "message_authorId_nonce_key" UNIQUE("authorId","nonce")
  );
  
  CREATE TABLE "message_ping" (
  	"messageId" text,
  	"userId" text,
  	CONSTRAINT "message_ping_pkey" PRIMARY KEY("messageId","userId")
  );
  
  CREATE TABLE "session" (
  	"createdAt" timestamp with time zone NOT NULL,
  	"id" text PRIMARY KEY,
  	"secretHash" bytea NOT NULL,
  	"userId" text NOT NULL
  );
  
  CREATE TABLE "user" (
  	"id" text PRIMARY KEY,
  	"avatarUrl" text,
  	"displayName" text,
  	"createdAt" timestamp with time zone NOT NULL,
  	"homeserverName" text NOT NULL,
  	"isBot" boolean NOT NULL,
  	"updatedAt" timestamp with time zone NOT NULL,
  	"username" text NOT NULL,
  	"status" text DEFAULT 'OFFLINE' NOT NULL,
  	CONSTRAINT "user_username_homeserverName_key" UNIQUE("username","homeserverName")
  );
  
  CREATE INDEX "attachment_channelId_idx" ON "attachment" ("channelId");
  CREATE INDEX "attachment_messageId_idx" ON "attachment" ("messageId");
  CREATE INDEX "attachment_uploaderId_idx" ON "attachment" ("uploaderId");
  CREATE INDEX "attachment_uploaderId_status_idx" ON "attachment" ("uploaderId","status");
  CREATE INDEX "channel_guildId_idx" ON "channel" ("guildId");
  CREATE INDEX "channel_guildId_position_idx" ON "channel" ("guildId","position");
  CREATE INDEX "channel_read_state_channelId_idx" ON "channel_read_state" ("channelId");
  CREATE INDEX "channel_read_state_userId_idx" ON "channel_read_state" ("userId");
  CREATE INDEX "federation_nonce_createdAt_idx" ON "federation_nonce" ("createdAt");
  CREATE INDEX "guild_invite_creatorId_idx" ON "guild_invite" ("creatorId");
  CREATE INDEX "guild_invite_guildId_idx" ON "guild_invite" ("guildId");
  CREATE INDEX "guild_member_guildId_idx" ON "guild_member" ("guildId");
  CREATE INDEX "guild_member_userId_idx" ON "guild_member" ("userId");
  CREATE INDEX "guild_ownerId_idx" ON "guild" ("ownerId");
  CREATE INDEX "local_credential_userId_idx" ON "local_credential" ("userId");
  CREATE INDEX "message_authorId_idx" ON "message" ("authorId");
  CREATE INDEX "message_channelId_createdAt_id_idx" ON "message" ("channelId","createdAt","id");
  CREATE INDEX "message_channelId_idx" ON "message" ("channelId");
  CREATE INDEX "message_ping_messageId_idx" ON "message_ping" ("messageId");
  CREATE INDEX "message_ping_userId_idx" ON "message_ping" ("userId");
  CREATE INDEX "session_userId_idx" ON "session" ("userId");
  ALTER TABLE "local_credential" ADD CONSTRAINT "local_credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
  ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
  ALTER TABLE "channel" ADD CONSTRAINT "channel_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guild"("id") ON DELETE CASCADE;
  ALTER TABLE "guild" ADD CONSTRAINT "guild_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id");
  ALTER TABLE "guild_member" ADD CONSTRAINT "guild_member_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guild"("id") ON DELETE CASCADE;
  ALTER TABLE "guild_member" ADD CONSTRAINT "guild_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
  ALTER TABLE "message" ADD CONSTRAINT "message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id");
  ALTER TABLE "message" ADD CONSTRAINT "message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE;
  ALTER TABLE "guild_invite" ADD CONSTRAINT "guild_invite_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "user"("id");
  ALTER TABLE "guild_invite" ADD CONSTRAINT "guild_invite_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guild"("id") ON DELETE CASCADE;
  ALTER TABLE "attachment" ADD CONSTRAINT "attachment_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE;
  ALTER TABLE "attachment" ADD CONSTRAINT "attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "message"("id") ON DELETE CASCADE;
  ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "user"("id");
  ALTER TABLE "channel_read_state" ADD CONSTRAINT "channel_read_state_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE;
  ALTER TABLE "channel_read_state" ADD CONSTRAINT "channel_read_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
  ALTER TABLE "message_ping" ADD CONSTRAINT "message_ping_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "message"("id") ON DELETE CASCADE;
  ALTER TABLE "message_ping" ADD CONSTRAINT "message_ping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
END
$$;
