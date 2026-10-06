CREATE TABLE "BusinessOperation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"requestId" uuid NOT NULL,
	"teamId" text,
	"mutation" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"token" uuid NOT NULL,
	"result" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_business_request" UNIQUE("chatId","requestId"),
	CONSTRAINT "chk_business_status" CHECK ("BusinessOperation"."status" in ('running', 'result_ready', 'completed', 'failed', 'uncertain'))
);
--> statement-breakpoint
ALTER TABLE "BusinessOperation" ADD CONSTRAINT "BusinessOperation_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "BusinessOperation" ADD CONSTRAINT "BusinessOperation_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_chat_running" ON "BusinessOperation" USING btree ("chatId") WHERE "BusinessOperation"."status" in ('running', 'result_ready');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_team_mutation" ON "BusinessOperation" USING btree ("teamId") WHERE "BusinessOperation"."mutation" and "BusinessOperation"."status" in ('running', 'result_ready', 'uncertain');