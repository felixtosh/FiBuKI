CREATE TABLE "transactions" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"user_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'userId') = 'string' THEN "data"->'userId' #>> '{}' END) STORED,
	"partner_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'partnerId') = 'string' THEN "data"->'partnerId' #>> '{}' END) STORED,
	"source_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'sourceId') = 'string' THEN "data"->'sourceId' #>> '{}' END) STORED,
	"no_receipt_category_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'noReceiptCategoryId') = 'string' THEN "data"->'noReceiptCategoryId' #>> '{}' END) STORED,
	"import_job_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'importJobId') = 'string' THEN "data"->'importJobId' #>> '{}' END) STORED,
	"dedupe_hash" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'dedupeHash') = 'string' THEN "data"->'dedupeHash' #>> '{}' END) STORED,
	"partner_matched_by" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'partnerMatchedBy') = 'string' THEN "data"->'partnerMatchedBy' #>> '{}' END) STORED,
	"no_receipt_category_matched_by" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'noReceiptCategoryMatchedBy') = 'string' THEN "data"->'noReceiptCategoryMatchedBy' #>> '{}' END) STORED,
	"is_complete" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'isComplete') = 'boolean' THEN ("data"->'isComplete' #>> '{}')::boolean END) STORED,
	"quota_exceeded" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'quotaExceeded') = 'boolean' THEN ("data"->'quotaExceeded' #>> '{}')::boolean END) STORED,
	"date" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'date' ? '__fbts__' THEN to_timestamp(("data"->'date'->'__fbts__'->>'s')::double precision + ("data"->'date'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	"created_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'createdAt' ? '__fbts__' THEN to_timestamp(("data"->'createdAt'->'__fbts__'->>'s')::double precision + ("data"->'createdAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	CONSTRAINT "transactions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_tenant_id_user_id_date_idx" ON "transactions" USING btree ("tenant_id","user_id","date");--> statement-breakpoint
CREATE INDEX "transactions_tenant_id_user_id_dedupe_hash_idx" ON "transactions" USING btree ("tenant_id","user_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "transactions_tenant_id_source_id_idx" ON "transactions" USING btree ("tenant_id","source_id");--> statement-breakpoint
-- ============================================================================
-- RLS backstop + app-role grant (hand-appended — drizzle-kit does not author
-- RLS or grants; see src/selfhost/db/schema.ts header and drizzle/0000_init.sql
-- for the full rationale). FORCE is load-bearing: the connecting user owns the
-- table and would otherwise bypass policies.
-- ============================================================================
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "transactions" TO fibuki_app;