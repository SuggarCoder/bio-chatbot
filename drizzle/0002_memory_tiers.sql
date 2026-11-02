ALTER TABLE "UserMemory" DROP CONSTRAINT "chk_user_memory_category";--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "reinforcedCount" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "expiresAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_user_memory_expiry" ON "UserMemory" USING btree ("expiresAt") WHERE "UserMemory"."expiresAt" is not null;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_reinforced" CHECK ("UserMemory"."reinforcedCount" >= 1);--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_category" CHECK ("UserMemory"."category" in ('identity', 'work', 'preference', 'current', 'other', 'episode'));--> statement-breakpoint
-- Existing memories were last confirmed when they were last written; recent focus ages out.
UPDATE "UserMemory" SET "lastSeenAt" = "updatedAt", "expiresAt" = CASE WHEN "category" = 'current' THEN "updatedAt" + interval '30 days' END;
