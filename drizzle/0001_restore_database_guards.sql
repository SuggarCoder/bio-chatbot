CREATE OR REPLACE FUNCTION "set_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."updatedAt" = now();
    RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_user_updated_at" ON "User";
--> statement-breakpoint
CREATE TRIGGER "trg_user_updated_at"
BEFORE UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_chat_updated_at" ON "Chat";
--> statement-breakpoint
CREATE TRIGGER "trg_chat_updated_at"
BEFORE UPDATE ON "Chat"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_vote_updated_at" ON "Vote";
--> statement-breakpoint
CREATE TRIGGER "trg_vote_updated_at"
BEFORE UPDATE ON "Vote"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_attachment_updated_at" ON "Attachment";
--> statement-breakpoint
CREATE TRIGGER "trg_attachment_updated_at"
BEFORE UPDATE ON "Attachment"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_job_updated_at" ON "AnalysisJob";
--> statement-breakpoint
CREATE TRIGGER "trg_job_updated_at"
BEFORE UPDATE ON "AnalysisJob"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_generation_updated_at" ON "Generation";
--> statement-breakpoint
CREATE TRIGGER "trg_generation_updated_at"
BEFORE UPDATE ON "Generation"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_artifact_updated_at" ON "Artifact";
--> statement-breakpoint
CREATE TRIGGER "trg_artifact_updated_at"
BEFORE UPDATE ON "Artifact"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_message_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."role" <> 'assistant'
       OR NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."chatId" IS DISTINCT FROM OLD."chatId"
       OR NEW."generationId" IS DISTINCT FROM OLD."generationId"
       OR NEW."seq" IS DISTINCT FROM OLD."seq"
       OR NEW."role" IS DISTINCT FROM OLD."role"
       OR NEW."clientMessageId" IS DISTINCT FROM OLD."clientMessageId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION
            'Message rows are immutable after insert; append a new message instead';
    END IF;

    RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_prevent_message_update" ON "Message";
--> statement-breakpoint
CREATE TRIGGER "trg_prevent_message_update"
BEFORE UPDATE ON "Message"
FOR EACH ROW
EXECUTE FUNCTION "prevent_message_update"();
--> statement-breakpoint
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_usage_generation_owner" ON "UsageEvent";
--> statement-breakpoint
CREATE TRIGGER "trg_usage_generation_owner"
BEFORE INSERT OR UPDATE ON "UsageEvent"
FOR EACH ROW
EXECUTE FUNCTION "enforce_usage_generation_owner"();
