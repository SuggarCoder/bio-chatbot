ALTER TABLE "User" ALTER COLUMN "generationConcurrencyLimit" SET DEFAULT 3;--> statement-breakpoint
-- Existing accounts still on the previous default get 3 concurrent chats; explicit overrides (>1) are kept.
UPDATE "User" SET "generationConcurrencyLimit" = 3, "updatedAt" = now() WHERE "generationConcurrencyLimit" = 1;
