ALTER TABLE "UserMemory" DROP CONSTRAINT "chk_user_memory_content";--> statement-breakpoint
ALTER TABLE "UserMemory" ALTER COLUMN "content" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN "incognito" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN "memoryExtractedSeq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The per-turn extractor already read existing chats; start the new cursor at their end.
UPDATE "Chat" SET "memoryExtractedSeq" = "nextMessageSeq" - 1;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "category" varchar(24) DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "source" varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "createdAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "memoryEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "chatSearchEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "memoryConsolidatedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_message_user_created" ON "Message" USING btree ("userId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_category" CHECK ("UserMemory"."category" in ('identity', 'work', 'preference', 'current', 'other'));--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_source" CHECK ("UserMemory"."source" in ('auto', 'user', 'tool'));--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_content" CHECK (length(trim("UserMemory"."content")) between 1 and 500);