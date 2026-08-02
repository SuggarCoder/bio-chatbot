ALTER TABLE "ArtifactVersion" DROP CONSTRAINT "ArtifactVersion_sourceMessageId_Message_id_fk";
--> statement-breakpoint
ALTER TABLE "ArtifactVersion" DROP CONSTRAINT "ArtifactVersion_sourceGenerationId_Generation_id_fk";
--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ALTER COLUMN "sourceMessageId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ALTER COLUMN "sourceGenerationId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceMessageId_Message_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."Message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceGenerationId_Generation_id_fk" FOREIGN KEY ("sourceGenerationId") REFERENCES "public"."Generation"("id") ON DELETE set null ON UPDATE no action;