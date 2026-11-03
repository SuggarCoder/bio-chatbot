CREATE TABLE "UsageMonthly" (
	"userId" uuid NOT NULL,
	"month" timestamp with time zone NOT NULL,
	"kind" varchar(32) NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"inputTokens" bigint DEFAULT 0 NOT NULL,
	"outputTokens" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_usage_monthly" PRIMARY KEY("userId","month","kind")
);
--> statement-breakpoint
ALTER TABLE "UsageMonthly" ADD CONSTRAINT "UsageMonthly_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_created" ON "AuditLog" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_background_job_finished" ON "BackgroundJob" USING btree ("finishedAt") WHERE "BackgroundJob"."finishedAt" is not null;--> statement-breakpoint
CREATE INDEX "idx_business_settled" ON "BusinessOperation" USING btree ("updatedAt") WHERE "BusinessOperation"."status" in ('completed', 'failed');--> statement-breakpoint
CREATE INDEX "idx_chat_deleted" ON "Chat" USING btree ("deletedAt") WHERE "Chat"."deletedAt" is not null;--> statement-breakpoint
CREATE INDEX "idx_ingress_settled" ON "IngressRequest" USING btree ("updatedAt") WHERE "IngressRequest"."status" in ('succeeded', 'failed');--> statement-breakpoint
CREATE INDEX "idx_outbox_settled" ON "OutboxEvent" USING btree ("updatedAt") WHERE "OutboxEvent"."status" in ('published', 'failed');--> statement-breakpoint
CREATE INDEX "idx_tool_run_started" ON "ToolRun" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_usage_created" ON "UsageEvent" USING btree ("createdAt");