CREATE TABLE "signup_invite" (
	"code" text PRIMARY KEY,
	"maxUses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp(3) with time zone,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_flow" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"pkceVerifier" text NOT NULL,
	"nonce" text NOT NULL,
	"redirectUri" text NOT NULL,
	"verifier" text NOT NULL,
	"linkUserId" text,
	"code" text UNIQUE,
	"subject" text,
	"email" text,
	"username" text,
	"displayName" text,
	"expiresAt" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_identity" (
	"provider" text,
	"subject" text,
	"userId" text NOT NULL,
	"email" text,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_identity_pkey" PRIMARY KEY("provider","subject"),
	CONSTRAINT "sso_identity_user_provider_unique" UNIQUE("userId","provider")
);
--> statement-breakpoint
ALTER TABLE "sso_flow" ADD CONSTRAINT "sso_flow_linkUserId_user_id_fkey" FOREIGN KEY ("linkUserId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_identity" ADD CONSTRAINT "sso_identity_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;