CREATE TABLE "ArtifactVersion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" uuid NOT NULL,
	"version" integer NOT NULL,
	"parentVersion" integer,
	"title" text NOT NULL,
	"mimeType" varchar(255) NOT NULL,
	"language" varchar(64),
	"storageProvider" varchar(32) NOT NULL,
	"storageKey" text NOT NULL,
	"contentHash" varchar(64) NOT NULL,
	"byteLength" bigint NOT NULL,
	"sourceMessageId" uuid NOT NULL,
	"sourceGenerationId" uuid NOT NULL,
	"streamArtifactId" uuid NOT NULL,
	"createdBy" varchar(20) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_artifact_version" UNIQUE("artifactId","version"),
	CONSTRAINT "uq_artifact_version_storage" UNIQUE("storageProvider","storageKey"),
	CONSTRAINT "uq_artifact_generation_stream" UNIQUE("sourceGenerationId","streamArtifactId"),
	CONSTRAINT "chk_artifact_version_number" CHECK ("ArtifactVersion"."version" >= 1),
	CONSTRAINT "chk_artifact_parent_version" CHECK ("ArtifactVersion"."parentVersion" is null or "ArtifactVersion"."parentVersion" >= 1),
	CONSTRAINT "chk_artifact_version_bytes" CHECK ("ArtifactVersion"."byteLength" >= 0),
	CONSTRAINT "chk_artifact_version_hash" CHECK ("ArtifactVersion"."contentHash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chk_artifact_version_creator" CHECK ("ArtifactVersion"."createdBy" in ('assistant', 'user'))
);
--> statement-breakpoint
ALTER TABLE "Artifact" DROP CONSTRAINT "chk_artifact_status";--> statement-breakpoint
ALTER TABLE "Artifact" ADD COLUMN "logicalId" varchar(64);--> statement-breakpoint
ALTER TABLE "Artifact" ADD COLUMN "currentVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_Artifact_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."Artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceMessageId_Message_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceGenerationId_Generation_id_fk" FOREIGN KEY ("sourceGenerationId") REFERENCES "public"."Generation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_version_history" ON "ArtifactVersion" USING btree ("artifactId","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_artifact_version_message" ON "ArtifactVersion" USING btree ("sourceMessageId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_chat_logical_id" ON "Artifact" USING btree ("userId","chatId","logicalId") WHERE "Artifact"."logicalId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "chk_artifact_current_version" CHECK ("Artifact"."currentVersion" >= 0);--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "chk_artifact_logical_id" CHECK ("Artifact"."logicalId" is null or "Artifact"."logicalId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$');--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "chk_artifact_status" CHECK ("Artifact"."status" in ('generating', 'ready', 'failed', 'expired', 'archived', 'deleted'));
