CREATE TABLE "bot" (
	"userId" text PRIMARY KEY,
	"ownerId" text NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"commands" jsonb DEFAULT '[]' NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "embeds" jsonb;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "components" jsonb;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "interaction" jsonb;--> statement-breakpoint
CREATE INDEX "bot_ownerId_idx" ON "bot" ("ownerId");--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_ownerId_user_id_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE;