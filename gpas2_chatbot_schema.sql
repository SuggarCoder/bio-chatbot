-- ============================================================
-- GPAS2 Commercial Chatbot - PostgreSQL 15+
-- Production baseline schema v2
--
-- Core rules
-- 1. All Chatbot users are registered GPAS2/platform users; no anonymous users.
-- 2. Chat has one owner. private = owner only; authenticated = all registered,
--    authenticated users can READ shared content only.
-- 3. Shared Chat never exposes Message_v2.parts directly. Shared views expose only
--    Message_v2.sharedText and safe Artifact fields.
-- 4. Attachment is always owner-only. Artifact report/table/chart may inherit Chat
--    sharing; file/dataset never inherit Chat sharing.
-- 5. Message_v2 is append-only after INSERT. Sequence allocation and Redis context
--    revision increments are performed in one application transaction.
-- 6. PostgreSQL is the authoritative source for user/chat/message/job/generation/
--    artifact/token-usage/audit state. Redis is cache/realtime/rate-limit only.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. User
-- ============================================================
CREATE TABLE IF NOT EXISTS "User" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Every Chatbot user maps to a registered platform account.
    "externalUserId" varchar(128) NOT NULL UNIQUE,
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

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "deletedAt" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_user_team"
ON "User" ("externalTeamId")
WHERE "externalTeamId" IS NOT NULL;


-- ============================================================
-- 2. Chat
-- ============================================================
CREATE TABLE IF NOT EXISTS "Chat" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Chat owner. Write operations always require userId = current user.
    "userId" uuid NOT NULL
        REFERENCES "User"("id")
        ON DELETE CASCADE,

    "title" text NOT NULL,
    "chatType" varchar(32) NOT NULL DEFAULT 'general',
    "status" varchar(20) NOT NULL DEFAULT 'active',

    -- private       : owner only
    -- authenticated : every registered + authenticated platform user may read
    "shareScope" varchar(20) NOT NULL DEFAULT 'private',

    -- snapshot : expose messages only through sharedThroughSeq
    -- live     : expose subsequent safe messages too
    "shareMode" varchar(16),
    "sharedThroughSeq" bigint,
    "sharedAt" timestamptz,

    -- Locator only, never an authentication credential.
    "shareSlug" varchar(64),

    -- Redis context key may be versioned with this value.
    "contextRevision" bigint NOT NULL DEFAULT 0,

    -- Application transaction reserves this sequence before inserting a message.
    "nextMessageSeq" bigint NOT NULL DEFAULT 1,

    -- A shared user may fork a Chat into a new owner-private Chat.
    "forkedFromChatId" uuid
        REFERENCES "Chat"("id")
        ON DELETE SET NULL,
    "forkedFromSeq" bigint,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "deletedAt" timestamptz,

    CONSTRAINT "chk_chat_status"
        CHECK ("status" IN ('active', 'archived')),

    CONSTRAINT "chk_chat_type"
        CHECK (
            "chatType" IN (
                'general',
                'analysis',
                'pipeline',
                'literature'
            )
        ),

    CONSTRAINT "chk_chat_next_seq"
        CHECK ("nextMessageSeq" >= 1),

    -- Either not forked at all, or both source Chat + source seq are present.
    CONSTRAINT "chk_chat_fork_state"
        CHECK (
            (
                "forkedFromChatId" IS NULL
                AND "forkedFromSeq" IS NULL
            )
            OR
            (
                "forkedFromChatId" IS NOT NULL
                AND "forkedFromSeq" IS NOT NULL
                AND "forkedFromSeq" >= 1
                AND "forkedFromChatId" <> "id"
            )
        ),

    CONSTRAINT "chk_chat_share_scope"
        CHECK ("shareScope" IN ('private', 'authenticated')),

    CONSTRAINT "chk_chat_share_mode"
        CHECK (
            "shareMode" IS NULL
            OR "shareMode" IN ('snapshot', 'live')
        ),

    -- Legal share states only:
    -- private                -> no share metadata
    -- authenticated/snapshot -> fixed through an existing seq
    -- authenticated/live     -> no seq boundary
    CONSTRAINT "chk_chat_share_state"
        CHECK (
            (
                "shareScope" = 'private'
                AND "shareMode" IS NULL
                AND "sharedThroughSeq" IS NULL
                AND "sharedAt" IS NULL
                AND "shareSlug" IS NULL
            )
            OR
            (
                "shareScope" = 'authenticated'
                AND "shareMode" = 'snapshot'
                AND "sharedThroughSeq" IS NOT NULL
                AND "sharedThroughSeq" >= 1
                AND "sharedThroughSeq" < "nextMessageSeq"
                AND "sharedAt" IS NOT NULL
                AND "shareSlug" IS NOT NULL
            )
            OR
            (
                "shareScope" = 'authenticated'
                AND "shareMode" = 'live'
                AND "sharedThroughSeq" IS NULL
                AND "sharedAt" IS NOT NULL
                AND "shareSlug" IS NOT NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS "idx_chat_user_active"
ON "Chat" (
    "userId",
    "status",
    "createdAt" DESC
)
WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_share_slug"
ON "Chat" ("shareSlug")
WHERE "shareSlug" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_chat_shared"
ON "Chat" ("sharedAt" DESC)
WHERE
    "shareScope" = 'authenticated'
    AND "deletedAt" IS NULL;


-- ============================================================
-- 3. Message_v2
-- ============================================================
CREATE TABLE IF NOT EXISTS "Message_v2" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    "chatId" uuid NOT NULL
        REFERENCES "Chat"("id")
        ON DELETE CASCADE,

    -- Stable ordering/cursor/snapshot boundary.
    "seq" bigint NOT NULL,

    "role" varchar(20) NOT NULL,

    -- Internal complete UIMessage parts. NEVER expose this column directly from
    -- shared Chat endpoints.
    "parts" jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Safe plain-text representation generated by the server from parts.
    -- Shared Chat endpoints/views use this field instead of parts.
    -- system/tool messages must keep sharedText NULL.
    "sharedText" text,

    -- Network retry idempotency for client-originated messages.
    "clientMessageId" varchar(128),

    "createdAt" timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "chk_message_role"
        CHECK (
            "role" IN (
                'user',
                'assistant',
                'system',
                'tool'
            )
        ),

    CONSTRAINT "chk_message_seq"
        CHECK ("seq" >= 1),

    CONSTRAINT "chk_message_shared_text"
        CHECK (
            "role" IN ('user', 'assistant')
            OR "sharedText" IS NULL
        ),

    -- Supports stable ordered queries and snapshot boundaries.
    CONSTRAINT "uq_message_chat_seq"
        UNIQUE ("chatId", "seq"),

    -- Required for Artifact(messageId, chatId) lineage validation.
    CONSTRAINT "uq_message_id_chat"
        UNIQUE ("id", "chatId")
);

-- Do NOT add another (chatId, seq) index: uq_message_chat_seq already provides it.

CREATE UNIQUE INDEX IF NOT EXISTS "uq_message_client_id"
ON "Message_v2" ("chatId", "clientMessageId")
WHERE "clientMessageId" IS NOT NULL;


-- ============================================================
-- 4. Vote_v2
-- ============================================================
CREATE TABLE IF NOT EXISTS "Vote_v2" (
    "messageId" uuid NOT NULL
        REFERENCES "Message_v2"("id")
        ON DELETE CASCADE,

    "userId" uuid NOT NULL
        REFERENCES "User"("id")
        ON DELETE CASCADE,

    "isUpvoted" boolean NOT NULL,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("messageId", "userId")
);


-- ============================================================
-- 5. Attachment
-- ============================================================
CREATE TABLE IF NOT EXISTS "Attachment" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Attachment is always owner-only and never inherits Chat sharing.
    "userId" uuid NOT NULL
        REFERENCES "User"("id")
        ON DELETE CASCADE,

    -- s3 / minio / local / oss / ...
    "storageProvider" varchar(32) NOT NULL,
    "storageKey" text NOT NULL,

    "fileName" text NOT NULL,
    "mimeType" varchar(255),
    "sizeBytes" bigint NOT NULL,
    "sha256" varchar(64),

    -- Processing lifecycle only. Deletion is represented solely by deletedAt.
    "status" varchar(20) NOT NULL DEFAULT 'uploading',

    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "deletedAt" timestamptz,

    CONSTRAINT "chk_attachment_size"
        CHECK ("sizeBytes" >= 0),

    CONSTRAINT "chk_attachment_status"
        CHECK (
            "status" IN (
                'uploading',
                'scanning',
                'ready',
                'quarantined',
                'failed'
            )
        ),

    CONSTRAINT "uq_attachment_storage"
        UNIQUE ("storageProvider", "storageKey")
);

CREATE INDEX IF NOT EXISTS "idx_attachment_user"
ON "Attachment" ("userId", "createdAt" DESC)
WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_attachment_sha"
ON "Attachment" ("userId", "sha256")
WHERE "sha256" IS NOT NULL
  AND "deletedAt" IS NULL;


-- ============================================================
-- 6. MessageAttachment
-- ============================================================
-- Shared Chat pages may indicate that a message had attachments, but attachment
-- metadata/content/download URLs must only be returned after owner authorization.
CREATE TABLE IF NOT EXISTS "MessageAttachment" (
    "messageId" uuid NOT NULL
        REFERENCES "Message_v2"("id")
        ON DELETE CASCADE,

    "attachmentId" uuid NOT NULL
        REFERENCES "Attachment"("id")
        ON DELETE CASCADE,

    "position" smallint NOT NULL DEFAULT 0,

    PRIMARY KEY ("messageId", "attachmentId"),

    CONSTRAINT "uq_message_attachment_position"
        UNIQUE ("messageId", "position"),

    CONSTRAINT "chk_message_attachment_position"
        CHECK ("position" >= 0)
);

CREATE INDEX IF NOT EXISTS "idx_message_attachment_attachment"
ON "MessageAttachment" ("attachmentId");


-- ============================================================
-- 7. Stream
-- ============================================================
CREATE TABLE IF NOT EXISTS "Stream" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    "chatId" uuid NOT NULL
        REFERENCES "Chat"("id")
        ON DELETE CASCADE,

    "createdAt" timestamptz NOT NULL DEFAULT now(),

    -- Default retention; the cleanup worker should purge expired rows.
    "expiresAt" timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

    CONSTRAINT "chk_stream_expiry"
        CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX IF NOT EXISTS "idx_stream_chat"
ON "Stream" ("chatId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_stream_expiry"
ON "Stream" ("expiresAt");


-- ============================================================
-- 8. AnalysisJob
-- ============================================================
CREATE TABLE IF NOT EXISTS "AnalysisJob" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Chat is the source of the task, not the lifecycle parent.
    "chatId" uuid
        REFERENCES "Chat"("id")
        ON DELETE SET NULL,

    -- User rows normally use soft delete; physical delete preserves job history.
    "userId" uuid
        REFERENCES "User"("id")
        ON DELETE SET NULL,

    -- Real job/workflow id from the internal analysis backend, when available.
    "externalJobId" varchar(256),

    "jobType" varchar(64) NOT NULL,
    "jobName" text,

    "params" jsonb NOT NULL DEFAULT '{}'::jsonb,

    "status" varchar(20) NOT NULL DEFAULT 'pending',
    "progress" smallint NOT NULL DEFAULT 0,

    -- Summary / references only; large outputs belong in Artifact/object storage.
    "result" jsonb,
    "error" text,

    -- User-level request idempotency.
    "idempotencyKey" varchar(128),

    "attempt" integer NOT NULL DEFAULT 0,
    "maxAttempts" integer NOT NULL DEFAULT 3,

    "workerId" varchar(128),
    "leaseUntil" timestamptz,
    "heartbeatAt" timestamptz,

    "cancelRequestedAt" timestamptz,

    "queuedAt" timestamptz,
    "startedAt" timestamptz,
    "finishedAt" timestamptz,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "chk_job_status"
        CHECK (
            "status" IN (
                'pending',
                'queued',
                'running',
                'completed',
                'failed',
                'cancelled'
            )
        ),

    CONSTRAINT "chk_job_progress"
        CHECK ("progress" BETWEEN 0 AND 100),

    CONSTRAINT "chk_job_attempt"
        CHECK (
            "attempt" >= 0
            AND "maxAttempts" >= 1
            AND "attempt" <= "maxAttempts"
        )
);

CREATE INDEX IF NOT EXISTS "idx_job_chat"
ON "AnalysisJob" ("chatId")
WHERE "chatId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_job_user_status"
ON "AnalysisJob" (
    "userId",
    "status",
    "createdAt" DESC
)
WHERE "userId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_job_active_status"
ON "AnalysisJob" (
    "status",
    "createdAt"
)
WHERE "status" IN ('pending', 'queued', 'running');

CREATE INDEX IF NOT EXISTS "idx_job_external"
ON "AnalysisJob" ("externalJobId")
WHERE "externalJobId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_idempotency"
ON "AnalysisJob" (
    "userId",
    "idempotencyKey"
)
WHERE "userId" IS NOT NULL
  AND "idempotencyKey" IS NOT NULL;


-- ============================================================
-- 9. JobEvent
-- ============================================================
CREATE TABLE IF NOT EXISTS "JobEvent" (
    "id" bigserial PRIMARY KEY,

    "jobId" uuid NOT NULL
        REFERENCES "AnalysisJob"("id")
        ON DELETE CASCADE,

    -- queued / acquired / retry / progress / completed / failed / ...
    "eventType" varchar(64) NOT NULL,
    "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_job_event_job"
ON "JobEvent" ("jobId", "id");


-- ============================================================
-- 10. Generation
-- ============================================================
CREATE TABLE IF NOT EXISTS "Generation" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Generation observability may be retained even if Chat is physically removed.
    "chatId" uuid
        REFERENCES "Chat"("id")
        ON DELETE SET NULL,

    "userId" uuid
        REFERENCES "User"("id")
        ON DELETE SET NULL,

    "userMessageId" uuid
        REFERENCES "Message_v2"("id")
        ON DELETE SET NULL,

    "assistantMessageId" uuid
        REFERENCES "Message_v2"("id")
        ON DELETE SET NULL,

    -- openai / anthropic / qwen / kimi / local / ...
    "provider" varchar(64) NOT NULL,
    "model" varchar(128) NOT NULL,

    -- Internal request id and optional provider request id.
    "requestId" varchar(128) NOT NULL,
    "providerRequestId" varchar(256),

    "status" varchar(20) NOT NULL DEFAULT 'pending',

    "inputTokens" bigint NOT NULL DEFAULT 0,
    "outputTokens" bigint NOT NULL DEFAULT 0,
    "cachedInputTokens" bigint NOT NULL DEFAULT 0,
    "reasoningTokens" bigint NOT NULL DEFAULT 0,

    -- Optional internal provider operating cost; NOT a user billing field.
    "providerCostUsd" numeric(18, 8),

    "latencyMs" integer,
    "timeToFirstTokenMs" integer,

    "finishReason" varchar(64),
    "errorCode" varchar(128),
    "errorMessage" text,

    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "finishedAt" timestamptz,

    CONSTRAINT "uq_generation_request_id"
        UNIQUE ("requestId"),

    CONSTRAINT "chk_generation_status"
        CHECK (
            "status" IN (
                'pending',
                'streaming',
                'completed',
                'failed',
                'cancelled'
            )
        ),

    CONSTRAINT "chk_generation_tokens"
        CHECK (
            "inputTokens" >= 0
            AND "outputTokens" >= 0
            AND "cachedInputTokens" >= 0
            AND "reasoningTokens" >= 0
        ),

    CONSTRAINT "chk_generation_cost"
        CHECK (
            "providerCostUsd" IS NULL
            OR "providerCostUsd" >= 0
        ),

    CONSTRAINT "chk_generation_latency"
        CHECK (
            ("latencyMs" IS NULL OR "latencyMs" >= 0)
            AND
            ("timeToFirstTokenMs" IS NULL OR "timeToFirstTokenMs" >= 0)
        )
);

CREATE INDEX IF NOT EXISTS "idx_generation_user_created"
ON "Generation" (
    "userId",
    "createdAt" DESC
)
WHERE "userId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_generation_chat"
ON "Generation" (
    "chatId",
    "createdAt"
)
WHERE "chatId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_generation_model"
ON "Generation" (
    "provider",
    "model",
    "createdAt" DESC
);


-- ============================================================
-- 11. ToolRun
-- ============================================================
CREATE TABLE IF NOT EXISTS "ToolRun" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    "generationId" uuid NOT NULL
        REFERENCES "Generation"("id")
        ON DELETE CASCADE,

    -- AI SDK/tool-provider call id. Side-effecting tools MUST persist ToolRun before
    -- executing the internal API, and reuse an existing row on unique conflict.
    "toolCallId" varchar(256),
    "toolName" varchar(128) NOT NULL,

    "status" varchar(20) NOT NULL DEFAULT 'pending',

    -- Store only required/desensitized values; sensitive raw payloads should not be
    -- persisted by default.
    "input" jsonb,
    "outputSummary" jsonb,
    "error" text,

    "startedAt" timestamptz NOT NULL DEFAULT now(),
    "finishedAt" timestamptz,

    CONSTRAINT "chk_tool_run_status"
        CHECK (
            "status" IN (
                'pending',
                'running',
                'completed',
                'failed',
                'cancelled'
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tool_run_call"
ON "ToolRun" ("generationId", "toolCallId")
WHERE "toolCallId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_tool_run_generation"
ON "ToolRun" ("generationId", "startedAt");

CREATE INDEX IF NOT EXISTS "idx_tool_run_name"
ON "ToolRun" ("toolName", "startedAt" DESC);


-- ============================================================
-- 12. Artifact
-- ============================================================
CREATE TABLE IF NOT EXISTS "Artifact" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    "userId" uuid
        REFERENCES "User"("id")
        ON DELETE SET NULL,

    "chatId" uuid
        REFERENCES "Chat"("id")
        ON DELETE SET NULL,

    -- Individual FK guarantees the Message disappears safely if physically deleted.
    "messageId" uuid
        REFERENCES "Message_v2"("id")
        ON DELETE SET NULL,

    "generationId" uuid
        REFERENCES "Generation"("id")
        ON DELETE SET NULL,

    "analysisJobId" uuid
        REFERENCES "AnalysisJob"("id")
        ON DELETE SET NULL,

    "title" text NOT NULL,

    -- report/table/chart may inherit Chat sharing; file/dataset are always owner-only.
    "artifactType" varchar(32) NOT NULL,

    "isChatShareable" boolean GENERATED ALWAYS AS (
        "artifactType" IN ('report', 'table', 'chart')
    ) STORED,

    "format" varchar(32) NOT NULL,
    "status" varchar(20) NOT NULL DEFAULT 'generating',

    -- Small web-renderable Artifact content.
    "content" text,

    -- Large/binary Artifact content lives in object storage.
    "storageProvider" varchar(32),
    "storageKey" text,

    "mimeType" varchar(255),
    "sizeBytes" bigint,
    "sha256" varchar(64),

    "error" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,

    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "expiresAt" timestamptz,
    "deletedAt" timestamptz,

    CONSTRAINT "chk_artifact_type"
        CHECK (
            "artifactType" IN (
                'report',
                'table',
                'chart',
                'file',
                'dataset'
            )
        ),

    CONSTRAINT "chk_artifact_format"
        CHECK (
            "format" IN (
                'html',
                'markdown',
                'pdf',
                'csv',
                'xlsx',
                'json',
                'png',
                'jpeg',
                'svg'
            )
        ),

    CONSTRAINT "chk_artifact_status"
        CHECK (
            "status" IN (
                'generating',
                'ready',
                'failed',
                'expired'
            )
        ),

    CONSTRAINT "chk_artifact_size"
        CHECK (
            "sizeBytes" IS NULL
            OR "sizeBytes" >= 0
        ),

    -- storageProvider/storageKey form one unit.
    CONSTRAINT "chk_artifact_storage"
        CHECK (
            (
                "storageProvider" IS NULL
                AND "storageKey" IS NULL
            )
            OR
            (
                "storageProvider" IS NOT NULL
                AND "storageKey" IS NOT NULL
            )
        ),

    -- A ready Artifact must have inline content or stored content.
    CONSTRAINT "chk_artifact_ready_content"
        CHECK (
            "status" <> 'ready'
            OR "content" IS NOT NULL
            OR "storageKey" IS NOT NULL
        ),

    CONSTRAINT "chk_artifact_expiry"
        CHECK (
            "expiresAt" IS NULL
            OR "expiresAt" > "createdAt"
        ),

    -- If an Artifact is attached to a Message, it must also carry that Chat id.
    CONSTRAINT "chk_artifact_message_chat_presence"
        CHECK (
            "messageId" IS NULL
            OR "chatId" IS NOT NULL
        ),

    -- Prevent cross-Chat lineage mistakes such as Artifact.chatId=Chat A while
    -- Artifact.messageId belongs to Chat B. When both are present, they must match.
    CONSTRAINT "fk_artifact_message_chat"
        FOREIGN KEY ("messageId", "chatId")
        REFERENCES "Message_v2"("id", "chatId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_artifact_storage"
ON "Artifact" ("storageProvider", "storageKey")
WHERE "storageKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_user"
ON "Artifact" ("userId", "createdAt" DESC)
WHERE "userId" IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_chat"
ON "Artifact" ("chatId", "createdAt" DESC)
WHERE "chatId" IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_message"
ON "Artifact" ("messageId")
WHERE "messageId" IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_generation"
ON "Artifact" ("generationId")
WHERE "generationId" IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_job"
ON "Artifact" ("analysisJobId")
WHERE "analysisJobId" IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_artifact_expiry"
ON "Artifact" ("expiresAt")
WHERE "expiresAt" IS NOT NULL
  AND "deletedAt" IS NULL;


-- ============================================================
-- 13. UsageEvent
-- ============================================================
-- Token usage only; used for quota/rate limiting. No user billing semantics.
CREATE TABLE IF NOT EXISTS "UsageEvent" (
    "id" bigserial PRIMARY KEY,

    "userId" uuid NOT NULL
        REFERENCES "User"("id")
        ON DELETE CASCADE,

    -- Normally present. NULL is reserved for explicit admin/history imports.
    "generationId" uuid
        REFERENCES "Generation"("id")
        ON DELETE SET NULL,

    "inputTokens" bigint NOT NULL DEFAULT 0,
    "outputTokens" bigint NOT NULL DEFAULT 0,

    -- Quota definition intentionally uses input + output only, independent of
    -- provider-specific cached/reasoning token accounting.
    "totalTokens" bigint GENERATED ALWAYS AS (
        "inputTokens" + "outputTokens"
    ) STORED,

    "createdAt" timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "chk_usage_tokens"
        CHECK (
            "inputTokens" >= 0
            AND "outputTokens" >= 0
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_usage_generation"
ON "UsageEvent" ("generationId")
WHERE "generationId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_usage_user_created"
ON "UsageEvent" ("userId", "createdAt" DESC);


-- ============================================================
-- 14. AuditLog
-- ============================================================
-- Recommended append-only at privilege level: application DB role should not have
-- UPDATE/DELETE on this table.
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" bigserial PRIMARY KEY,

    "actorUserId" uuid
        REFERENCES "User"("id")
        ON DELETE SET NULL,

    -- Allows audit attribution after a User row is physically purged.
    "actorExternalUserId" varchar(128),

    "requestId" varchar(128),

    -- SHARE_CHAT / REVOKE_CHAT_SHARE / VIEW_SHARED_CHAT / RUN_ANALYSIS /
    -- CALL_TOOL / DOWNLOAD_REPORT / DELETE_CHAT / ...
    "action" varchar(128) NOT NULL,

    "outcome" varchar(16) NOT NULL DEFAULT 'success',

    "resourceType" varchar(64),
    "resourceId" text,

    "ip" inet,
    "userAgent" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,

    "createdAt" timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "chk_audit_outcome"
        CHECK ("outcome" IN ('success', 'denied', 'failed'))
);

CREATE INDEX IF NOT EXISTS "idx_audit_actor"
ON "AuditLog" ("actorUserId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_audit_resource"
ON "AuditLog" (
    "resourceType",
    "resourceId",
    "createdAt" DESC
);

CREATE INDEX IF NOT EXISTS "idx_audit_request"
ON "AuditLog" ("requestId")
WHERE "requestId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_audit_outcome"
ON "AuditLog" ("outcome", "createdAt" DESC);


-- ============================================================
-- 15. updatedAt maintenance
-- ============================================================
CREATE OR REPLACE FUNCTION "set_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."updatedAt" = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_user_updated_at" ON "User";
CREATE TRIGGER "trg_user_updated_at"
BEFORE UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_chat_updated_at" ON "Chat";
CREATE TRIGGER "trg_chat_updated_at"
BEFORE UPDATE ON "Chat"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_vote_updated_at" ON "Vote_v2";
CREATE TRIGGER "trg_vote_updated_at"
BEFORE UPDATE ON "Vote_v2"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_attachment_updated_at" ON "Attachment";
CREATE TRIGGER "trg_attachment_updated_at"
BEFORE UPDATE ON "Attachment"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_job_updated_at" ON "AnalysisJob";
CREATE TRIGGER "trg_job_updated_at"
BEFORE UPDATE ON "AnalysisJob"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_generation_updated_at" ON "Generation";
CREATE TRIGGER "trg_generation_updated_at"
BEFORE UPDATE ON "Generation"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

DROP TRIGGER IF EXISTS "trg_artifact_updated_at" ON "Artifact";
CREATE TRIGGER "trg_artifact_updated_at"
BEFORE UPDATE ON "Artifact"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();


-- ============================================================
-- 16. Message immutability
-- ============================================================
-- Message rows are append-only once inserted. This keeps snapshot share boundaries
-- stable and prevents silent rewriting of historical Chat context.
-- Streaming/recoverable partial output belongs in Stream; persist Message_v2 after
-- finalization.
CREATE OR REPLACE FUNCTION "prevent_message_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Message_v2 rows are immutable after insert; append a new message instead';
END;
$$;

DROP TRIGGER IF EXISTS "trg_prevent_message_update" ON "Message_v2";
CREATE TRIGGER "trg_prevent_message_update"
BEFORE UPDATE ON "Message_v2"
FOR EACH ROW
EXECUTE FUNCTION "prevent_message_update"();


-- ============================================================
-- 17. UsageEvent ownership enforcement
-- ============================================================
-- When generationId is present, UsageEvent.userId is derived from Generation.userId.
-- The caller cannot assign token usage to another user.
CREATE OR REPLACE FUNCTION "enforce_usage_generation_owner"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_user_id uuid;
BEGIN
    IF NEW."generationId" IS NOT NULL THEN
        SELECT "userId"
          INTO generation_user_id
          FROM "Generation"
         WHERE "id" = NEW."generationId";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Generation % does not exist', NEW."generationId";
        END IF;

        IF generation_user_id IS NULL THEN
            RAISE EXCEPTION
                'Generation % has no active user ownership',
                NEW."generationId";
        END IF;

        NEW."userId" := generation_user_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_usage_generation_owner" ON "UsageEvent";
CREATE TRIGGER "trg_usage_generation_owner"
BEFORE INSERT OR UPDATE ON "UsageEvent"
FOR EACH ROW
EXECUTE FUNCTION "enforce_usage_generation_owner"();


-- ============================================================
-- 18. Safe shared-read views
-- ============================================================
-- IMPORTANT: These views enforce content shape/scope, not authentication itself.
-- The API must resolve the requester through GPAS2 /info and obtain a valid registered externalUserId before using these shared views.

CREATE OR REPLACE VIEW "SharedChat" AS
SELECT
    c."id",
    c."userId" AS "ownerUserId",
    c."title",
    c."chatType",
    c."shareMode",
    c."sharedThroughSeq",
    c."sharedAt",
    c."shareSlug",
    c."createdAt",
    c."updatedAt"
FROM "Chat" c
WHERE
    c."shareScope" = 'authenticated'
    AND c."deletedAt" IS NULL;

-- Does not expose Message_v2.parts, tool payloads, system messages, reasoning, or
-- attachment data. The service must derive sharedText server-side from UI-safe text.
CREATE OR REPLACE VIEW "SharedChatMessage" AS
SELECT
    m."id",
    m."chatId",
    m."seq",
    m."role",
    m."sharedText",
    m."createdAt"
FROM "Message_v2" m
JOIN "Chat" c
  ON c."id" = m."chatId"
WHERE
    c."shareScope" = 'authenticated'
    AND c."deletedAt" IS NULL
    AND m."role" IN ('user', 'assistant')
    AND m."sharedText" IS NOT NULL
    AND (
        c."shareMode" = 'live'
        OR (
            c."shareMode" = 'snapshot'
            AND m."seq" <= c."sharedThroughSeq"
        )
    );

-- Only display-type Artifacts inherit Chat sharing. No storage provider/key, sha256,
-- metadata, dataset, file, or Attachment information is exposed by this view.
CREATE OR REPLACE VIEW "SharedArtifact" AS
SELECT
    a."id",
    a."chatId",
    a."messageId",
    a."title",
    a."artifactType",
    a."format",
    a."status",
    a."content",
    a."mimeType",
    a."sizeBytes",
    (a."storageKey" IS NOT NULL) AS "hasStoredContent",
    a."createdAt",
    a."updatedAt",
    a."expiresAt"
FROM "Artifact" a
JOIN "Message_v2" m
  ON m."id" = a."messageId"
 AND m."chatId" = a."chatId"
JOIN "Chat" c
  ON c."id" = a."chatId"
WHERE
    c."shareScope" = 'authenticated'
    AND c."deletedAt" IS NULL
    AND a."isChatShareable" = true
    AND a."status" = 'ready'
    AND a."deletedAt" IS NULL
    AND (a."expiresAt" IS NULL OR a."expiresAt" > now())
    AND (
        c."shareMode" = 'live'
        OR (
            c."shareMode" = 'snapshot'
            AND m."seq" <= c."sharedThroughSeq"
        )
    );


-- ============================================================
-- 19. Application transaction requirements
-- ============================================================
-- Message sequence allocation and contextRevision invalidation intentionally do NOT
-- use INSERT triggers. This keeps Drizzle's NOT NULL insert model aligned with the DB
-- and avoids two updates to Chat per message.
--
-- For every new Message_v2, Fastify/Drizzle MUST execute the following in ONE DB
-- transaction:
--
--   UPDATE "Chat"
--      SET "nextMessageSeq" = "nextMessageSeq" + 1,
--          "contextRevision" = "contextRevision" + 1
--    WHERE "id" = :chatId
--      AND "userId" = :currentUserId
--      AND "deletedAt" IS NULL
--   RETURNING "nextMessageSeq" - 1 AS "seq";
--
-- Then INSERT Message_v2 using the returned seq. A zero-row UPDATE means the caller
-- does not own an active Chat and the INSERT must not occur.
--
-- Shared Chat reads must use SharedChat / SharedChatMessage / SharedArtifact, never
-- SELECT * from Message_v2 or Artifact for non-owner users.
--
-- Tool idempotency requirement:
-- INSERT ToolRun(generationId, toolCallId, ...) BEFORE calling a side-effecting
-- internal API. On uq_tool_run_call conflict, reuse the existing ToolRun/result/status
-- rather than invoking the tool again.
-- ============================================================

COMMIT;
