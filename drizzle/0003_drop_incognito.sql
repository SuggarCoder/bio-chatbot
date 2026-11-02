-- Incognito chats become ordinary chats. What was said while they were
-- incognito is never read into memory: start their extraction cursor at the end.
UPDATE "Chat" SET "memoryExtractedSeq" = "nextMessageSeq" - 1 WHERE "incognito";--> statement-breakpoint
ALTER TABLE "Chat" DROP COLUMN "incognito";
