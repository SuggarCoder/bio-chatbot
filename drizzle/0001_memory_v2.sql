-- Cross-chat search stores embeddings; the database must provide pgvector.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "MessageChunk" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"assistantMessageId" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"embeddingModel" varchar(64),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "MessageChunk_assistantMessageId_unique" UNIQUE("assistantMessageId"),
	CONSTRAINT "chk_message_chunk_content" CHECK (length("MessageChunk"."content") > 0)
);
--> statement-breakpoint
ALTER TABLE "BackgroundJob" DROP CONSTRAINT "chk_background_job_type";--> statement-breakpoint
ALTER TABLE "UsageEvent" DROP CONSTRAINT "chk_usage_kind";--> statement-breakpoint
ALTER TABLE "UserMemory" DROP CONSTRAINT "chk_user_memory_content";--> statement-breakpoint
ALTER TABLE "UserMemory" ALTER COLUMN "content" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN "incognito" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN "memoryExtractedSeq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing chats were read by the per-turn extractor; start the cursor at their end.
UPDATE "Chat" SET "memoryExtractedSeq" = "nextMessageSeq" - 1;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "category" varchar(24) DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "source" varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD COLUMN "createdAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "memoryEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "chatSearchEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "memoryConsolidatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "MessageChunk" ADD CONSTRAINT "MessageChunk_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageChunk" ADD CONSTRAINT "MessageChunk_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageChunk" ADD CONSTRAINT "MessageChunk_assistantMessageId_Message_id_fk" FOREIGN KEY ("assistantMessageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageChunk" ADD CONSTRAINT "fk_message_chunk_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_chunk_user_created" ON "MessageChunk" USING btree ("userId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_message_chunk_chat" ON "MessageChunk" USING btree ("chatId","seq");--> statement-breakpoint
CREATE INDEX "idx_message_user_created" ON "Message" USING btree ("userId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "chk_background_job_type" CHECK ("BackgroundJob"."type" in ('chat.summary', 'user.memory', 'chat.index'));--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "chk_usage_kind" CHECK ("UsageEvent"."kind" in ('chat', 'summary', 'memory', 'embedding'));--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_category" CHECK ("UserMemory"."category" in ('identity', 'work', 'preference', 'current', 'other'));--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_source" CHECK ("UserMemory"."source" in ('auto', 'user', 'tool'));--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "chk_user_memory_content" CHECK (length(trim("UserMemory"."content")) between 1 and 500);