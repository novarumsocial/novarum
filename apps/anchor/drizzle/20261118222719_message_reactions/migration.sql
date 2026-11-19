CREATE TABLE "message_reaction" (
	"messageId" text,
	"userId" text,
	"emoji" text,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reaction_pkey" PRIMARY KEY("messageId","emoji","userId")
);
--> statement-breakpoint
CREATE INDEX "message_reaction_userId_idx" ON "message_reaction" ("userId");--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_messageId_message_id_fkey" FOREIGN KEY ("messageId") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;