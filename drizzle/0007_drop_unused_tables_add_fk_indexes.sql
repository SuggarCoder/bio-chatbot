-- Nothing reads or writes these. The views go first: they depend on the tables below.
DROP VIEW "public"."SharedArtifact";--> statement-breakpoint
DROP VIEW "public"."SharedChatMessage";--> statement-breakpoint
DROP VIEW "public"."SharedChat";--> statement-breakpoint
ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_analysisJobId_AnalysisJob_id_fk";--> statement-breakpoint
ALTER TABLE "Artifact" DROP CONSTRAINT "fk_artifact_user_analysis_job";--> statement-breakpoint
DROP TABLE "JobEvent";--> statement-breakpoint
DROP TABLE "MessageAttachment";--> statement-breakpoint
DROP TABLE "AnalysisJob";--> statement-breakpoint
DROP TABLE "Attachment";--> statement-breakpoint
DROP INDEX "idx_artifact_message";--> statement-breakpoint
DROP INDEX "idx_artifact_generation";--> statement-breakpoint
DROP INDEX "idx_artifact_job";--> statement-breakpoint
ALTER TABLE "BusinessOperation" ADD CONSTRAINT "fk_business_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "IngressRequest" ADD CONSTRAINT "fk_ingress_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_version_generation" ON "ArtifactVersion" USING btree ("sourceGenerationId") WHERE "ArtifactVersion"."sourceGenerationId" is not null;--> statement-breakpoint
CREATE INDEX "idx_artifact_message_ref" ON "Artifact" USING btree ("messageId") WHERE "Artifact"."messageId" is not null;--> statement-breakpoint
CREATE INDEX "idx_artifact_generation_ref" ON "Artifact" USING btree ("generationId") WHERE "Artifact"."generationId" is not null;--> statement-breakpoint
CREATE INDEX "idx_generation_user_message" ON "Generation" USING btree ("userMessageId");