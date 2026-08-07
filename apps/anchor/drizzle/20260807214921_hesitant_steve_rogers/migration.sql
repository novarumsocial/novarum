ALTER TABLE "local_credential" ADD COLUMN "totpSecret" bytea;--> statement-breakpoint
ALTER TABLE "local_credential" ADD COLUMN "mfaEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_credential" ADD COLUMN "mfaOptions" text DEFAULT 'NONE' NOT NULL;