CREATE TABLE "partners" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"user_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'userId') = 'string' THEN "data"->'userId' #>> '{}' END) STORED,
	"is_active" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'isActive') = 'boolean' THEN ("data"->'isActive' #>> '{}')::boolean END) STORED,
	"global_partner_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'globalPartnerId') = 'string' THEN "data"->'globalPartnerId' #>> '{}' END) STORED,
	"name" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'name') = 'string' THEN "data"->'name' #>> '{}' END) STORED,
	CONSTRAINT "partners_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partners_tenant_id_user_id_idx" ON "partners" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "partners_tenant_id_global_partner_id_idx" ON "partners" USING btree ("tenant_id","global_partner_id");--> statement-breakpoint
-- ============================================================================
-- RLS backstop + app-role grant (hand-appended — drizzle-kit does not author
-- RLS or grants; see src/selfhost/db/schema.ts header and drizzle/0000_init.sql
-- for the full rationale). FORCE is load-bearing: the connecting user owns the
-- table and would otherwise bypass policies.
-- ============================================================================
ALTER TABLE "partners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "partners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partners"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "partners" TO fibuki_app;