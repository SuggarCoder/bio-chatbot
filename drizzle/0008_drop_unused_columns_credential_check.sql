ALTER TABLE "Chat" DROP CONSTRAINT "chk_chat_fork_state";--> statement-breakpoint
ALTER TABLE "Generation" DROP CONSTRAINT "chk_generation_cost";--> statement-breakpoint
ALTER TABLE "Chat" DROP CONSTRAINT "Chat_forkedFromChatId_Chat_id_fk";--> statement-breakpoint
ALTER TABLE "Chat" DROP CONSTRAINT "fk_chat_user_fork";--> statement-breakpoint
ALTER TABLE "Artifact" DROP COLUMN "analysisJobId";--> statement-breakpoint
ALTER TABLE "Artifact" DROP COLUMN "isChatShareable";--> statement-breakpoint
ALTER TABLE "Chat" DROP COLUMN "forkedFromChatId";--> statement-breakpoint
ALTER TABLE "Chat" DROP COLUMN "forkedFromSeq";--> statement-breakpoint
ALTER TABLE "Generation" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "Generation" DROP COLUMN "providerCostUsd";--> statement-breakpoint
-- Generations cancelled while queued or lost to outbox failures kept their sealed Cookie.
UPDATE "Generation" SET "credential" = NULL
WHERE "credential" IS NOT NULL
  AND "status" NOT IN ('created', 'queued', 'scheduled', 'running', 'cancelling');--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "chk_generation_credential_active" CHECK ("Generation"."credential" is null or "Generation"."status" in ('created', 'queued', 'scheduled', 'running', 'cancelling'));