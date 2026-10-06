CREATE TABLE "IngressRequest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"requestId" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payloadHash" text NOT NULL,
	"credential" text,
	"externalUserId" text NOT NULL,
	"teamId" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"plan" jsonb,
	"result" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"token" uuid,
	"leaseUntil" timestamp with time zone,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ingress_request" UNIQUE("userId","requestId"),
	CONSTRAINT "chk_ingress_status" CHECK ("IngressRequest"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "IngressRequest" ADD CONSTRAINT "IngressRequest_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "IngressRequest" ADD CONSTRAINT "IngressRequest_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ingress_active_chat" ON "IngressRequest" USING btree ("chatId") WHERE "IngressRequest"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_ingress_pending" ON "IngressRequest" USING btree ("availableAt") WHERE "IngressRequest"."status" in ('queued', 'running');