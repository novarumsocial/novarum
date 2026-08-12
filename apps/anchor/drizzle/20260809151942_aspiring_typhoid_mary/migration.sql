CREATE TYPE "mfa_method" AS ENUM('TOTP', 'EMAIL');--> statement-breakpoint
ALTER TABLE "local_credential" ADD COLUMN "totpSecret" bytea;--> statement-breakpoint
ALTER TABLE "local_credential" ADD COLUMN "mfaOptions" "mfa_method"[] DEFAULT ARRAY[]::"mfa_method"[] NOT NULL;