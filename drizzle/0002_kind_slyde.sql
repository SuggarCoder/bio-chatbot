CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "ArtifactSection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"artifactId" uuid NOT NULL,
	"version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"byteStart" bigint NOT NULL,
	"byteEnd" bigint NOT NULL,
	"headingPath" text DEFAULT '' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"embedding" vector(512),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_artifact_section_ordinal" UNIQUE("artifactId","version","ordinal"),
	CONSTRAINT "chk_artifact_section_ordinal" CHECK ("ArtifactSection"."ordinal" >= 0),
	CONSTRAINT "chk_artifact_section_range" CHECK ("ArtifactSection"."byteStart" >= 0 and "ArtifactSection"."byteEnd" > "ArtifactSection"."byteStart")
);
--> statement-breakpoint
CREATE TABLE "BackgroundJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"type" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'created' NOT NULL,
	"dedupeKey" varchar(255) NOT NULL,
	"chatId" uuid,
	"artifactVersionId" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"workerId" varchar(128),
	"startedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "BackgroundJob_dedupeKey_unique" UNIQUE("dedupeKey"),
	CONSTRAINT "uq_background_job_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_background_job_type" CHECK ("BackgroundJob"."type" in ('chat.summary', 'user.memory', 'artifact.index')),
	CONSTRAINT "chk_background_job_status" CHECK ("BackgroundJob"."status" in ('created', 'queued', 'running', 'completed', 'failed')),
	CONSTRAINT "chk_background_job_attempt" CHECK ("BackgroundJob"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ChatSummary" (
	"userId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"version" integer NOT NULL,
	"coveredMaxSeq" bigint NOT NULL,
	"summary" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ChatSummary_chatId_version_pk" PRIMARY KEY("chatId","version"),
	CONSTRAINT "uq_chat_summary_coverage" UNIQUE("chatId","coveredMaxSeq"),
	CONSTRAINT "uq_chat_summary_user_chat_version" UNIQUE("userId","chatId","version"),
	CONSTRAINT "chk_chat_summary_version" CHECK ("ChatSummary"."version" >= 1),
	CONSTRAINT "chk_chat_summary_seq" CHECK ("ChatSummary"."coveredMaxSeq" >= 1),
	CONSTRAINT "chk_chat_summary_content" CHECK (length("ChatSummary"."summary") > 0)
);
--> statement-breakpoint
CREATE TABLE "UserMemory" (
	"userId" uuid NOT NULL,
	"key" varchar(96) NOT NULL,
	"content" varchar(200) NOT NULL,
	"sourceChatId" uuid,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UserMemory_userId_key_pk" PRIMARY KEY("userId","key"),
	CONSTRAINT "chk_user_memory_key" CHECK (length(trim("UserMemory"."key")) > 0),
	CONSTRAINT "chk_user_memory_content" CHECK (length(trim("UserMemory"."content")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD COLUMN "outline" text;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD COLUMN "outlineStatus" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD COLUMN "outlineError" text;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD COLUMN "outlinedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD COLUMN "restoreRequestId" uuid;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD COLUMN "backgroundJobId" uuid;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD COLUMN "kind" varchar(32) DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "uq_artifact_version_user_artifact_version" UNIQUE("userId","artifactId","version");--> statement-breakpoint
ALTER TABLE "ArtifactSection" ADD CONSTRAINT "ArtifactSection_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactSection" ADD CONSTRAINT "ArtifactSection_artifactId_Artifact_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."Artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactSection" ADD CONSTRAINT "fk_artifact_section_version" FOREIGN KEY ("userId","artifactId","version") REFERENCES "public"."ArtifactVersion"("userId","artifactId","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_artifactVersionId_ArtifactVersion_id_fk" FOREIGN KEY ("artifactVersionId") REFERENCES "public"."ArtifactVersion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "fk_background_job_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChatSummary" ADD CONSTRAINT "ChatSummary_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChatSummary" ADD CONSTRAINT "ChatSummary_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChatSummary" ADD CONSTRAINT "fk_chat_summary_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserMemory" ADD CONSTRAINT "fk_user_memory_source_chat" FOREIGN KEY ("userId","sourceChatId") REFERENCES "public"."Chat"("userId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_section_version" ON "ArtifactSection" USING btree ("artifactId","version","ordinal");--> statement-breakpoint
CREATE INDEX "idx_artifact_section_embedding" ON "ArtifactSection" USING hnsw ("embedding" vector_cosine_ops) WHERE "ArtifactSection"."embedding" is not null;--> statement-breakpoint
CREATE INDEX "idx_background_job_dispatch" ON "BackgroundJob" USING btree ("status","availableAt","createdAt");--> statement-breakpoint
CREATE INDEX "idx_background_job_chat" ON "BackgroundJob" USING btree ("chatId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_chat_summary_latest" ON "ChatSummary" USING btree ("chatId","coveredMaxSeq" DESC NULLS LAST,"version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_memory_recent" ON "UserMemory" USING btree ("userId","updatedAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_backgroundJobId_BackgroundJob_id_fk" FOREIGN KEY ("backgroundJobId") REFERENCES "public"."BackgroundJob"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "fk_usage_user_background_job" FOREIGN KEY ("userId","backgroundJobId") REFERENCES "public"."BackgroundJob"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_version_restore_request" ON "ArtifactVersion" USING btree ("userId","restoreRequestId") WHERE "ArtifactVersion"."restoreRequestId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_background_job" ON "UsageEvent" USING btree ("backgroundJobId") WHERE "UsageEvent"."backgroundJobId" is not null;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "chk_artifact_outline_status" CHECK ("ArtifactVersion"."outlineStatus" in ('pending', 'processing', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "chk_usage_kind" CHECK ("UsageEvent"."kind" in ('chat', 'summary', 'memory'));
