CREATE TABLE "QuotaVoucherEvent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"delta" integer NOT NULL,
	"resetAt" timestamp with time zone,
	"weeklyBaseline" bigint,
	"monthlyBaseline" bigint,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_quota_voucher_kind" CHECK ("QuotaVoucherEvent"."kind" in ('grant', 'redeem')),
	CONSTRAINT "chk_quota_voucher_redeem" CHECK ("QuotaVoucherEvent"."kind" <> 'redeem' or ("QuotaVoucherEvent"."resetAt" is not null and "QuotaVoucherEvent"."weeklyBaseline" >= 0 and "QuotaVoucherEvent"."monthlyBaseline" >= 0))
);
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "resetVoucherBalance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "QuotaVoucherEvent" ADD CONSTRAINT "QuotaVoucherEvent_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_quota_voucher_user_kind_created" ON "QuotaVoucherEvent" USING btree ("userId","kind","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "chk_user_reset_voucher_balance" CHECK ("User"."resetVoucherBalance" >= 0);