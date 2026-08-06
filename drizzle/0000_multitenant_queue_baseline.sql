CREATE TABLE "AnalysisJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chatId" uuid,
	"userId" uuid NOT NULL,
	"externalJobId" varchar(256),
	"jobType" varchar(64) NOT NULL,
	"jobName" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"progress" smallint DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"idempotencyKey" varchar(128),
	"attempt" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"workerId" varchar(128),
	"leaseUntil" timestamp with time zone,
	"heartbeatAt" timestamp with time zone,
	"cancelRequestedAt" timestamp with time zone,
	"queuedAt" timestamp with time zone,
	"startedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"originToolRunId" uuid,
	CONSTRAINT "uq_analysis_job_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_job_status" CHECK ("AnalysisJob"."status" in ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "chk_job_progress" CHECK ("AnalysisJob"."progress" between 0 and 100),
	CONSTRAINT "chk_job_attempt" CHECK ("AnalysisJob"."attempt" >= 0 and "AnalysisJob"."maxAttempts" >= 1
        and "AnalysisJob"."attempt" <= "AnalysisJob"."maxAttempts")
);
--> statement-breakpoint
CREATE TABLE "ArtifactVersion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
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
	"sourceMessageId" uuid,
	"sourceGenerationId" uuid,
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
CREATE TABLE "Artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"chatId" uuid,
	"messageId" uuid,
	"generationId" uuid,
	"analysisJobId" uuid,
	"logicalId" varchar(64),
	"currentVersion" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"artifactType" varchar(32) NOT NULL,
	"isChatShareable" boolean GENERATED ALWAYS AS ("artifactType" in ('report', 'table', 'chart')) STORED,
	"format" varchar(32) NOT NULL,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"content" text,
	"storageProvider" varchar(32),
	"storageKey" text,
	"mimeType" varchar(255),
	"sizeBytes" bigint,
	"sha256" varchar(64),
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "uq_artifact_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_artifact_type" CHECK ("Artifact"."artifactType" in ('report', 'table', 'chart', 'file', 'dataset')),
	CONSTRAINT "chk_artifact_format" CHECK ("Artifact"."format" in ('html', 'markdown', 'text', 'code', 'mermaid', 'pdf', 'csv', 'xlsx', 'json', 'png', 'jpeg', 'svg')),
	CONSTRAINT "chk_artifact_status" CHECK ("Artifact"."status" in ('generating', 'ready', 'failed', 'expired', 'archived', 'deleted')),
	CONSTRAINT "chk_artifact_current_version" CHECK ("Artifact"."currentVersion" >= 0),
	CONSTRAINT "chk_artifact_logical_id" CHECK ("Artifact"."logicalId" is null or "Artifact"."logicalId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "chk_artifact_size" CHECK ("Artifact"."sizeBytes" is null or "Artifact"."sizeBytes" >= 0),
	CONSTRAINT "chk_artifact_storage" CHECK (("Artifact"."storageProvider" is null and "Artifact"."storageKey" is null)
        or ("Artifact"."storageProvider" is not null and "Artifact"."storageKey" is not null)),
	CONSTRAINT "chk_artifact_ready_content" CHECK ("Artifact"."status" <> 'ready' or "Artifact"."content" is not null or "Artifact"."storageKey" is not null),
	CONSTRAINT "chk_artifact_expiry" CHECK ("Artifact"."expiresAt" is null or "Artifact"."expiresAt" > "Artifact"."createdAt"),
	CONSTRAINT "chk_artifact_message_chat_presence" CHECK ("Artifact"."messageId" is null or "Artifact"."chatId" is not null)
);
--> statement-breakpoint
CREATE TABLE "Attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"storageProvider" varchar(32) NOT NULL,
	"storageKey" text NOT NULL,
	"fileName" text NOT NULL,
	"mimeType" varchar(255),
	"sizeBytes" bigint NOT NULL,
	"sha256" varchar(64),
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "uq_attachment_storage" UNIQUE("storageProvider","storageKey"),
	CONSTRAINT "uq_attachment_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_attachment_size" CHECK ("Attachment"."sizeBytes" >= 0),
	CONSTRAINT "chk_attachment_status" CHECK ("Attachment"."status" in ('uploading', 'scanning', 'ready', 'quarantined', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actorUserId" uuid,
	"actorExternalUserId" varchar(128),
	"requestId" varchar(128),
	"action" varchar(128) NOT NULL,
	"outcome" varchar(16) DEFAULT 'success' NOT NULL,
	"resourceType" varchar(64),
	"resourceId" text,
	"ip" "inet",
	"userAgent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_audit_outcome" CHECK ("AuditLog"."outcome" in ('success', 'denied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "Chat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"title" text NOT NULL,
	"chatType" varchar(32) DEFAULT 'general' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"shareScope" varchar(20) DEFAULT 'private' NOT NULL,
	"shareMode" varchar(16),
	"sharedThroughSeq" bigint,
	"sharedAt" timestamp with time zone,
	"shareSlug" varchar(64),
	"contextRevision" bigint DEFAULT 0 NOT NULL,
	"nextMessageSeq" bigint DEFAULT 1 NOT NULL,
	"forkedFromChatId" uuid,
	"forkedFromSeq" bigint,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "uq_chat_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_chat_status" CHECK ("Chat"."status" in ('active', 'archived')),
	CONSTRAINT "chk_chat_type" CHECK ("Chat"."chatType" in ('general', 'analysis', 'pipeline', 'literature')),
	CONSTRAINT "chk_chat_next_seq" CHECK ("Chat"."nextMessageSeq" >= 1),
	CONSTRAINT "chk_chat_fork_state" CHECK ((
        ("Chat"."forkedFromChatId" is null and "Chat"."forkedFromSeq" is null)
        or
        ("Chat"."forkedFromChatId" is not null and "Chat"."forkedFromSeq" is not null
          and "Chat"."forkedFromSeq" >= 1 and "Chat"."forkedFromChatId" <> "Chat"."id")
      )),
	CONSTRAINT "chk_chat_share_scope" CHECK ("Chat"."shareScope" in ('private', 'authenticated')),
	CONSTRAINT "chk_chat_share_mode" CHECK ("Chat"."shareMode" is null or "Chat"."shareMode" in ('snapshot', 'live')),
	CONSTRAINT "chk_chat_share_state" CHECK ((
        ("Chat"."shareScope" = 'private' and "Chat"."shareMode" is null
          and "Chat"."sharedThroughSeq" is null and "Chat"."sharedAt" is null
          and "Chat"."shareSlug" is null)
        or
        ("Chat"."shareScope" = 'authenticated' and "Chat"."shareMode" = 'snapshot'
          and "Chat"."sharedThroughSeq" is not null and "Chat"."sharedThroughSeq" >= 1
          and "Chat"."sharedThroughSeq" < "Chat"."nextMessageSeq"
          and "Chat"."sharedAt" is not null and "Chat"."shareSlug" is not null)
        or
        ("Chat"."shareScope" = 'authenticated' and "Chat"."shareMode" = 'live'
          and "Chat"."sharedThroughSeq" is null and "Chat"."sharedAt" is not null
          and "Chat"."shareSlug" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "Generation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chatId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"userMessageId" uuid NOT NULL,
	"assistantMessageId" uuid NOT NULL,
	"supersedesGenerationId" uuid,
	"provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"streamId" varchar(256) NOT NULL,
	"requestId" varchar(128) NOT NULL,
	"providerRequestId" varchar(256),
	"status" varchar(20) DEFAULT 'created' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"workerId" varchar(128),
	"providerRequestStartedAt" timestamp with time zone,
	"queuedAt" timestamp with time zone,
	"scheduledAt" timestamp with time zone,
	"startedAt" timestamp with time zone,
	"cancelRequestedAt" timestamp with time zone,
	"cancelSource" varchar(32),
	"inputTokens" bigint DEFAULT 0 NOT NULL,
	"outputTokens" bigint DEFAULT 0 NOT NULL,
	"cachedInputTokens" bigint DEFAULT 0 NOT NULL,
	"reasoningTokens" bigint DEFAULT 0 NOT NULL,
	"providerCostUsd" numeric(18, 8),
	"latencyMs" integer,
	"timeToFirstTokenMs" integer,
	"finishReason" varchar(64),
	"errorCode" varchar(128),
	"errorMessage" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"finishedAt" timestamp with time zone,
	CONSTRAINT "uq_generation_user_request_id" UNIQUE("userId","requestId"),
	CONSTRAINT "uq_generation_user_id" UNIQUE("userId","id"),
	CONSTRAINT "uq_generation_chat_id" UNIQUE("chatId","id"),
	CONSTRAINT "uq_generation_stream_id" UNIQUE("streamId"),
	CONSTRAINT "chk_generation_status" CHECK ("Generation"."status" in (
        'created', 'queued', 'scheduled', 'running', 'cancelling',
        'completed', 'cancelled', 'failed', 'interrupted', 'timed_out'
      )),
	CONSTRAINT "chk_generation_attempt" CHECK ("Generation"."attempt" >= 0),
	CONSTRAINT "chk_generation_tokens" CHECK ("Generation"."inputTokens" >= 0 and "Generation"."outputTokens" >= 0
        and "Generation"."cachedInputTokens" >= 0 and "Generation"."reasoningTokens" >= 0),
	CONSTRAINT "chk_generation_cost" CHECK ("Generation"."providerCostUsd" is null or "Generation"."providerCostUsd" >= 0),
	CONSTRAINT "chk_generation_latency" CHECK (("Generation"."latencyMs" is null or "Generation"."latencyMs" >= 0)
        and ("Generation"."timeToFirstTokenMs" is null or "Generation"."timeToFirstTokenMs" >= 0)),
	CONSTRAINT "chk_generation_cancel_source" CHECK ("Generation"."cancelSource" is null or "Generation"."cancelSource" in (
        'user_stop', 'superseded', 'timeout', 'server_shutdown', 'system'
      )),
	CONSTRAINT "chk_generation_cancel_fields" CHECK (("Generation"."cancelRequestedAt" is null and "Generation"."cancelSource" is null)
        or ("Generation"."cancelRequestedAt" is not null and "Generation"."cancelSource" is not null)),
	CONSTRAINT "chk_generation_finished_at" CHECK (("Generation"."status" in ('completed', 'failed', 'cancelled', 'interrupted', 'timed_out') and "Generation"."finishedAt" is not null)
        or ("Generation"."status" in ('created', 'queued', 'scheduled', 'running', 'cancelling') and "Generation"."finishedAt" is null))
);
--> statement-breakpoint
CREATE TABLE "JobEvent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"jobId" uuid NOT NULL,
	"eventType" varchar(64) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "MessageAttachment" (
	"userId" uuid NOT NULL,
	"messageId" uuid NOT NULL,
	"attachmentId" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "MessageAttachment_messageId_attachmentId_pk" PRIMARY KEY("messageId","attachmentId"),
	CONSTRAINT "uq_message_attachment_position" UNIQUE("messageId","position"),
	CONSTRAINT "chk_message_attachment_position" CHECK ("MessageAttachment"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "Message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"generationId" uuid,
	"seq" bigint NOT NULL,
	"role" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"content" text,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sharedText" text,
	"clientMessageId" varchar(128),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_message_chat_seq" UNIQUE("chatId","seq"),
	CONSTRAINT "uq_message_user_id" UNIQUE("userId","id"),
	CONSTRAINT "uq_message_id_chat" UNIQUE("id","chatId"),
	CONSTRAINT "chk_message_role" CHECK ("Message"."role" in ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "chk_message_seq" CHECK ("Message"."seq" >= 1),
	CONSTRAINT "chk_message_status" CHECK ((
        ("Message"."role" = 'assistant' and "Message"."status" in ('pending', 'streaming', 'completed', 'cancelled', 'failed'))
        or ("Message"."role" <> 'assistant' and "Message"."status" = 'completed')
      )),
	CONSTRAINT "chk_message_shared_text" CHECK ("Message"."sharedText" is null or (
        "Message"."role" in ('user', 'assistant') and "Message"."status" = 'completed'
      ))
);
--> statement-breakpoint
CREATE TABLE "OutboxEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"aggregateId" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"publishedAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_outbox_status" CHECK ("OutboxEvent"."status" in ('pending', 'published', 'failed')),
	CONSTRAINT "chk_outbox_attempts" CHECK ("OutboxEvent"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ToolRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"generationId" uuid NOT NULL,
	"toolCallId" varchar(256),
	"toolName" varchar(128) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"outputSummary" jsonb,
	"error" text,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"finishedAt" timestamp with time zone,
	CONSTRAINT "uq_tool_run_user_id" UNIQUE("userId","id"),
	CONSTRAINT "chk_tool_run_status" CHECK ("ToolRun"."status" in ('pending', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "UsageEvent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"generationId" uuid,
	"inputTokens" bigint DEFAULT 0 NOT NULL,
	"outputTokens" bigint DEFAULT 0 NOT NULL,
	"totalTokens" bigint GENERATED ALWAYS AS ("inputTokens" + "outputTokens") STORED,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_tokens" CHECK ("UsageEvent"."inputTokens" >= 0 and "UsageEvent"."outputTokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"externalUserId" varchar(128) NOT NULL,
	"externalTeamId" varchar(128),
	"realName" text,
	"userName" varchar(64),
	"jobTitle" varchar(64),
	"researchField" text,
	"phone" varchar(32),
	"gpas2Role" integer,
	"email" varchar(320),
	"name" text,
	"image" text,
	"serviceTier" varchar(20) DEFAULT 'free' NOT NULL,
	"schedulingWeight" integer DEFAULT 1 NOT NULL,
	"generationConcurrencyLimit" integer DEFAULT 1 NOT NULL,
	"maxQueuedGenerations" integer DEFAULT 5 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "User_externalUserId_unique" UNIQUE("externalUserId"),
	CONSTRAINT "chk_user_service_tier" CHECK ("User"."serviceTier" in ('free', 'pro', 'enterprise')),
	CONSTRAINT "chk_user_scheduling_weight" CHECK ("User"."schedulingWeight" >= 1),
	CONSTRAINT "chk_user_generation_concurrency" CHECK ("User"."generationConcurrencyLimit" >= 1),
	CONSTRAINT "chk_user_max_queued_generations" CHECK ("User"."maxQueuedGenerations" >= 1)
);
--> statement-breakpoint
CREATE TABLE "Vote" (
	"messageId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"isUpvoted" boolean NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Vote_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_originToolRunId_ToolRun_id_fk" FOREIGN KEY ("originToolRunId") REFERENCES "public"."ToolRun"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "fk_analysis_job_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "fk_analysis_job_user_tool_run" FOREIGN KEY ("userId","originToolRunId") REFERENCES "public"."ToolRun"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_Artifact_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."Artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceMessageId_Message_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."Message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_sourceGenerationId_Generation_id_fk" FOREIGN KEY ("sourceGenerationId") REFERENCES "public"."Generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "fk_artifact_version_user_artifact" FOREIGN KEY ("userId","artifactId") REFERENCES "public"."Artifact"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "fk_artifact_version_user_message" FOREIGN KEY ("userId","sourceMessageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "fk_artifact_version_user_generation" FOREIGN KEY ("userId","sourceGenerationId") REFERENCES "public"."Generation"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_messageId_Message_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_generationId_Generation_id_fk" FOREIGN KEY ("generationId") REFERENCES "public"."Generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_analysisJobId_AnalysisJob_id_fk" FOREIGN KEY ("analysisJobId") REFERENCES "public"."AnalysisJob"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "fk_artifact_message_chat" FOREIGN KEY ("messageId","chatId") REFERENCES "public"."Message"("id","chatId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "fk_artifact_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "fk_artifact_user_message" FOREIGN KEY ("userId","messageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "fk_artifact_user_generation" FOREIGN KEY ("userId","generationId") REFERENCES "public"."Generation"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "fk_artifact_user_analysis_job" FOREIGN KEY ("userId","analysisJobId") REFERENCES "public"."AnalysisJob"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_User_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_forkedFromChatId_Chat_id_fk" FOREIGN KEY ("forkedFromChatId") REFERENCES "public"."Chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Chat" ADD CONSTRAINT "fk_chat_user_fork" FOREIGN KEY ("userId","forkedFromChatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_userMessageId_Message_id_fk" FOREIGN KEY ("userMessageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_assistantMessageId_Message_id_fk" FOREIGN KEY ("assistantMessageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_supersedesGenerationId_Generation_id_fk" FOREIGN KEY ("supersedesGenerationId") REFERENCES "public"."Generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "fk_generation_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "fk_generation_user_message" FOREIGN KEY ("userId","userMessageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "fk_generation_assistant_message" FOREIGN KEY ("userId","assistantMessageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "fk_generation_user_supersedes" FOREIGN KEY ("userId","supersedesGenerationId") REFERENCES "public"."Generation"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Generation" ADD CONSTRAINT "fk_generation_chat_supersedes" FOREIGN KEY ("chatId","supersedesGenerationId") REFERENCES "public"."Generation"("chatId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_AnalysisJob_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."AnalysisJob"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "JobEvent" ADD CONSTRAINT "fk_job_event_user_job" FOREIGN KEY ("userId","jobId") REFERENCES "public"."AnalysisJob"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_Message_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_Attachment_id_fk" FOREIGN KEY ("attachmentId") REFERENCES "public"."Attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "fk_message_attachment_user_message" FOREIGN KEY ("userId","messageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "fk_message_attachment_user_attachment" FOREIGN KEY ("userId","attachmentId") REFERENCES "public"."Attachment"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "fk_message_user_chat" FOREIGN KEY ("userId","chatId") REFERENCES "public"."Chat"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_generationId_Generation_id_fk" FOREIGN KEY ("generationId") REFERENCES "public"."Generation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ToolRun" ADD CONSTRAINT "fk_tool_run_user_generation" FOREIGN KEY ("userId","generationId") REFERENCES "public"."Generation"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_generationId_Generation_id_fk" FOREIGN KEY ("generationId") REFERENCES "public"."Generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UsageEvent" ADD CONSTRAINT "fk_usage_user_generation" FOREIGN KEY ("userId","generationId") REFERENCES "public"."Generation"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_messageId_Message_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Vote" ADD CONSTRAINT "fk_vote_user_message" FOREIGN KEY ("userId","messageId") REFERENCES "public"."Message"("userId","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_job_chat" ON "AnalysisJob" USING btree ("chatId") WHERE "AnalysisJob"."chatId" is not null;--> statement-breakpoint
CREATE INDEX "idx_job_user_status" ON "AnalysisJob" USING btree ("userId","status","createdAt" DESC NULLS LAST) WHERE "AnalysisJob"."userId" is not null;--> statement-breakpoint
CREATE INDEX "idx_job_active_status" ON "AnalysisJob" USING btree ("status","createdAt") WHERE "AnalysisJob"."status" in ('pending', 'queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_job_external" ON "AnalysisJob" USING btree ("externalJobId") WHERE "AnalysisJob"."externalJobId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_idempotency" ON "AnalysisJob" USING btree ("userId","idempotencyKey") WHERE "AnalysisJob"."userId" is not null and "AnalysisJob"."idempotencyKey" is not null;--> statement-breakpoint
CREATE INDEX "idx_job_origin_tool" ON "AnalysisJob" USING btree ("originToolRunId") WHERE "AnalysisJob"."originToolRunId" is not null;--> statement-breakpoint
CREATE INDEX "idx_artifact_version_history" ON "ArtifactVersion" USING btree ("artifactId","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_artifact_version_message" ON "ArtifactVersion" USING btree ("sourceMessageId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_storage" ON "Artifact" USING btree ("storageProvider","storageKey") WHERE "Artifact"."storageKey" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_chat_logical_id" ON "Artifact" USING btree ("userId","chatId","logicalId") WHERE "Artifact"."logicalId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_user" ON "Artifact" USING btree ("userId","createdAt" DESC NULLS LAST) WHERE "Artifact"."userId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_chat" ON "Artifact" USING btree ("chatId","createdAt" DESC NULLS LAST) WHERE "Artifact"."chatId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_message" ON "Artifact" USING btree ("messageId") WHERE "Artifact"."messageId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_generation" ON "Artifact" USING btree ("generationId") WHERE "Artifact"."generationId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_job" ON "Artifact" USING btree ("analysisJobId") WHERE "Artifact"."analysisJobId" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_artifact_expiry" ON "Artifact" USING btree ("expiresAt") WHERE "Artifact"."expiresAt" is not null and "Artifact"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_attachment_user" ON "Attachment" USING btree ("userId","createdAt" DESC NULLS LAST) WHERE "Attachment"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_attachment_sha" ON "Attachment" USING btree ("userId","sha256") WHERE "Attachment"."sha256" is not null and "Attachment"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "AuditLog" USING btree ("actorUserId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_resource" ON "AuditLog" USING btree ("resourceType","resourceId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_request" ON "AuditLog" USING btree ("requestId") WHERE "AuditLog"."requestId" is not null;--> statement-breakpoint
CREATE INDEX "idx_audit_outcome" ON "AuditLog" USING btree ("outcome","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_chat_user_active" ON "Chat" USING btree ("userId","status","createdAt" DESC NULLS LAST) WHERE "Chat"."deletedAt" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_share_slug" ON "Chat" USING btree ("shareSlug") WHERE "Chat"."shareSlug" is not null;--> statement-breakpoint
CREATE INDEX "idx_chat_shared" ON "Chat" USING btree ("sharedAt" DESC NULLS LAST) WHERE "Chat"."shareScope" = 'authenticated' and "Chat"."deletedAt" is null;--> statement-breakpoint
CREATE INDEX "idx_generation_supersedes" ON "Generation" USING btree ("supersedesGenerationId") WHERE "Generation"."supersedesGenerationId" is not null;--> statement-breakpoint
CREATE INDEX "idx_generation_completed_supersedes" ON "Generation" USING btree ("supersedesGenerationId") WHERE "Generation"."supersedesGenerationId" is not null and "Generation"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "idx_generation_user_created" ON "Generation" USING btree ("userId","createdAt" DESC NULLS LAST) WHERE "Generation"."userId" is not null;--> statement-breakpoint
CREATE INDEX "idx_generation_chat" ON "Generation" USING btree ("chatId","createdAt") WHERE "Generation"."chatId" is not null;--> statement-breakpoint
CREATE INDEX "idx_generation_model" ON "Generation" USING btree ("provider","model","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_assistant_message" ON "Generation" USING btree ("assistantMessageId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_chat_active" ON "Generation" USING btree ("chatId") WHERE "Generation"."status" in ('scheduled', 'running', 'cancelling');--> statement-breakpoint
CREATE INDEX "idx_job_event_job" ON "JobEvent" USING btree ("jobId","id");--> statement-breakpoint
CREATE INDEX "idx_message_attachment_attachment" ON "MessageAttachment" USING btree ("attachmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_generation" ON "Message" USING btree ("generationId") WHERE "Message"."generationId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_client_id" ON "Message" USING btree ("chatId","clientMessageId") WHERE "Message"."clientMessageId" is not null;--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "OutboxEvent" USING btree ("status","availableAt","createdAt");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "OutboxEvent" USING btree ("aggregateId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tool_run_call" ON "ToolRun" USING btree ("generationId","toolCallId") WHERE "ToolRun"."toolCallId" is not null;--> statement-breakpoint
CREATE INDEX "idx_tool_run_generation" ON "ToolRun" USING btree ("generationId","startedAt");--> statement-breakpoint
CREATE INDEX "idx_tool_run_name" ON "ToolRun" USING btree ("toolName","startedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_generation" ON "UsageEvent" USING btree ("generationId") WHERE "UsageEvent"."generationId" is not null;--> statement-breakpoint
CREATE INDEX "idx_usage_user_created" ON "UsageEvent" USING btree ("userId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_team" ON "User" USING btree ("externalTeamId") WHERE "User"."externalTeamId" is not null;--> statement-breakpoint
CREATE VIEW "public"."SharedArtifact" AS (select "Artifact"."id", "Artifact"."chatId", "Artifact"."messageId", "Artifact"."title", "Artifact"."artifactType", "Artifact"."format", "Artifact"."status", "Artifact"."content", "Artifact"."mimeType", "Artifact"."sizeBytes", "Artifact"."storageKey" is not null as "hasStoredContent", "Artifact"."createdAt", "Artifact"."updatedAt", "Artifact"."expiresAt" from "Artifact" inner join "Message" on "Message"."id" = "Artifact"."messageId" and "Message"."chatId" = "Artifact"."chatId" inner join "Chat" on "Chat"."id" = "Artifact"."chatId" where 
      "Chat"."shareScope" = 'authenticated'
      and "Chat"."deletedAt" is null
      and "Artifact"."isChatShareable" = true
      and "Artifact"."status" = 'ready'
      and "Message"."status" = 'completed'
      and "Artifact"."deletedAt" is null
      and ("Artifact"."expiresAt" is null or "Artifact"."expiresAt" > now())
      and (
        "Chat"."shareMode" = 'live'
        or ("Chat"."shareMode" = 'snapshot' and "Message"."seq" <= "Chat"."sharedThroughSeq")
      )
    );--> statement-breakpoint
CREATE VIEW "public"."SharedChatMessage" AS (select "Message"."id", "Message"."chatId", "Message"."seq", "Message"."role", "Message"."sharedText", "Message"."createdAt" from "Message" inner join "Chat" on "Chat"."id" = "Message"."chatId" where 
      "Chat"."shareScope" = 'authenticated'
      and "Chat"."deletedAt" is null
      and "Message"."role" in ('user', 'assistant')
      and "Message"."status" = 'completed'
      and "Message"."sharedText" is not null
      and (
        "Chat"."shareMode" = 'live'
        or ("Chat"."shareMode" = 'snapshot' and "Message"."seq" <= "Chat"."sharedThroughSeq")
      )
    );--> statement-breakpoint
CREATE VIEW "public"."SharedChat" AS (select "id", "userId" as "ownerUserId", "title", "chatType", "shareMode", "sharedThroughSeq", "sharedAt", "shareSlug", "createdAt", "updatedAt" from "Chat" where "Chat"."shareScope" = 'authenticated' and "Chat"."deletedAt" is null);