CREATE TABLE "file_connections" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"file_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'fileId') = 'string' THEN "data"->'fileId' #>> '{}' END) STORED,
	"transaction_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'transactionId') = 'string' THEN "data"->'transactionId' #>> '{}' END) STORED,
	"user_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'userId') = 'string' THEN "data"->'userId' #>> '{}' END) STORED,
	"connection_type" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'connectionType') = 'string' THEN "data"->'connectionType' #>> '{}' END) STORED,
	"created_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'createdAt' ? '__fbts__' THEN to_timestamp(("data"->'createdAt'->'__fbts__'->>'s')::double precision + ("data"->'createdAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	CONSTRAINT "file_connections_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "file_connections" ADD CONSTRAINT "file_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_connections_tenant_id_transaction_id_idx" ON "file_connections" USING btree ("tenant_id","transaction_id");--> statement-breakpoint
CREATE INDEX "file_connections_tenant_id_file_id_idx" ON "file_connections" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE INDEX "file_connections_tenant_id_user_id_created_at_idx" ON "file_connections" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
-- ============================================================================
-- RLS backstop + app-role grant (hand-appended — drizzle-kit does not author
-- RLS or grants; see src/selfhost/db/schema.ts header and drizzle/0000_init.sql
-- for the full rationale). FORCE is load-bearing: the connecting user owns the
-- table and would otherwise bypass policies.
-- ============================================================================
ALTER TABLE "file_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "file_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "file_connections"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "file_connections" TO fibuki_app;