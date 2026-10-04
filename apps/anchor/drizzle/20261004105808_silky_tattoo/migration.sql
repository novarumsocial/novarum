CREATE TYPE "notification_level" AS ENUM('ALL', 'MENTIONS', 'NONE');--> statement-breakpoint
CREATE TYPE "push_kind" AS ENUM('WEBPUSH', 'UNIFIEDPUSH');--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"userId" text PRIMARY KEY,
	"push" boolean DEFAULT true NOT NULL,
	"messagePreview" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_setting" (
	"userId" text,
	"targetId" text,
	"level" "notification_level" DEFAULT 'ALL'::"notification_level" NOT NULL,
	"mutedUntil" timestamp(3) with time zone,
	CONSTRAINT "notification_setting_pkey" PRIMARY KEY("userId","targetId")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"sessionId" text NOT NULL,
	"kind" "push_kind" NOT NULL,
	"endpoint" text NOT NULL CONSTRAINT "push_subscription_endpoint_unique" UNIQUE,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "push_subscription_userId_idx" ON "push_subscription" ("userId");--> statement-breakpoint
CREATE INDEX "push_subscription_sessionId_idx" ON "push_subscription" ("sessionId");--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_sessionId_session_id_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE;