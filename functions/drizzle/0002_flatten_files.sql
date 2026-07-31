CREATE TABLE "files" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"user_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'userId') = 'string' THEN "data"->'userId' #>> '{}' END) STORED,
	"partner_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'partnerId') = 'string' THEN "data"->'partnerId' #>> '{}' END) STORED,
	"partner_matched_by" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'partnerMatchedBy') = 'string' THEN "data"->'partnerMatchedBy' #>> '{}' END) STORED,
	"content_hash" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'contentHash') = 'string' THEN "data"->'contentHash' #>> '{}' END) STORED,
	"source_type" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'sourceType') = 'string' THEN "data"->'sourceType' #>> '{}' END) STORED,
	"gmail_message_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'gmailMessageId') = 'string' THEN "data"->'gmailMessageId' #>> '{}' END) STORED,
	"gmail_attachment_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'gmailAttachmentId') = 'string' THEN "data"->'gmailAttachmentId' #>> '{}' END) STORED,
	"extraction_error" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'extractionError') = 'string' THEN "data"->'extractionError' #>> '{}' END) STORED,
	"extraction_complete" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'extractionComplete') = 'boolean' THEN ("data"->'extractionComplete' #>> '{}')::boolean END) STORED,
	"partner_match_complete" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'partnerMatchComplete') = 'boolean' THEN ("data"->'partnerMatchComplete' #>> '{}')::boolean END) STORED,
	"transaction_match_complete" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'transactionMatchComplete') = 'boolean' THEN ("data"->'transactionMatchComplete' #>> '{}')::boolean END) STORED,
	"extracted_date" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'extractedDate' ? '__fbts__' THEN to_timestamp(("data"->'extractedDate'->'__fbts__'->>'s')::double precision + ("data"->'extractedDate'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	"uploaded_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'uploadedAt' ? '__fbts__' THEN to_timestamp(("data"->'uploadedAt'->'__fbts__'->>'s')::double precision + ("data"->'uploadedAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	"updated_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'updatedAt' ? '__fbts__' THEN to_timestamp(("data"->'updatedAt'->'__fbts__'->>'s')::double precision + ("data"->'updatedAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	"created_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'createdAt' ? '__fbts__' THEN to_timestamp(("data"->'createdAt'->'__fbts__'->>'s')::double precision + ("data"->'createdAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	CONSTRAINT "files_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_tenant_id_user_id_uploaded_at_idx" ON "files" USING btree ("tenant_id","user_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "files_tenant_id_user_id_content_hash_idx" ON "files" USING btree ("tenant_id","user_id","content_hash");--> statement-breakpoint
CREATE INDEX "files_tenant_id_user_id_gmail_message_id_idx" ON "files" USING btree ("tenant_id","user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "files_tenant_id_partner_id_idx" ON "files" USING btree ("tenant_id","partner_id");--> statement-breakpoint
-- ============================================================================
-- RLS backstop + app-role grant (hand-appended — drizzle-kit does not author
-- RLS or grants; see src/selfhost/db/schema.ts header and drizzle/0000_init.sql
-- for the full rationale). FORCE is load-bearing: the connecting user owns the
-- table and would otherwise bypass policies.
-- ============================================================================
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "files"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "files" TO fibuki_app;
