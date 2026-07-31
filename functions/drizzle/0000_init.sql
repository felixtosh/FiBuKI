CREATE TABLE "docs" (
	"tenant_id" uuid NOT NULL,
	"path" text NOT NULL,
	"collection_path" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "docs_tenant_id_path_pk" PRIMARY KEY("tenant_id","path")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"user_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'userId') = 'string' THEN "data"->'userId' #>> '{}' END) STORED,
	"is_active" boolean GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'isActive') = 'boolean' THEN ("data"->'isActive' #>> '{}')::boolean END) STORED,
	"name" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'name') = 'string' THEN "data"->'name' #>> '{}' END) STORED,
	"linked_source_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'linkedSourceId') = 'string' THEN "data"->'linkedSourceId' #>> '{}' END) STORED,
	"api_config_account_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'apiConfig'->'accountId') = 'string' THEN "data"->'apiConfig'->'accountId' #>> '{}' END) STORED,
	"created_at" timestamp with time zone GENERATED ALWAYS AS (CASE WHEN "data"->'createdAt' ? '__fbts__' THEN to_timestamp(("data"->'createdAt'->'__fbts__'->>'s')::double precision + ("data"->'createdAt'->'__fbts__'->>'n')::double precision / 1e9) END) STORED,
	CONSTRAINT "sources_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_tenant_collection_idx" ON "docs" USING btree ("tenant_id","collection_path");--> statement-breakpoint
CREATE INDEX "sources_tenant_id_user_id_idx" ON "sources" USING btree ("tenant_id","user_id");--> statement-breakpoint
-- ============================================================================
-- RLS backstop (hand-appended — drizzle-kit does not author RLS; see
-- src/selfhost/db/schema.ts header). The API layer is the enforcement point;
-- these policies are the seatbelt: a query that ever runs without its tenant
-- scoped returns nothing instead of leaking another tenant's tax data.
-- FORCE is load-bearing: tests and the selfhost deployment connect as the
-- table owner, who would otherwise bypass policies.
-- Every statement runs inside a transaction with
--   set_config('app.tenant_id', <tenant>, true)  -- i.e. SET LOCAL
-- applied by the shim's tenant-scoped transaction wrapper.
-- ============================================================================
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenants"
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "docs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "docs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sources"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The application role. Superusers bypass RLS no matter what (PGlite and the
-- docker-image postgres user are superusers), so ALL document IO runs under
-- SET LOCAL ROLE fibuki_app inside the tenant transaction — a plain role the
-- policies actually apply to. Migrations/DDL keep running as the connecting
-- (owner) user. New tables must be added to the GRANT below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'fibuki_app') THEN
    CREATE ROLE fibuki_app;
  END IF;
  BEGIN
    EXECUTE format('GRANT fibuki_app TO %I', session_user);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- already a member, or superuser who does not need it
  END;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fibuki_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenants", "docs", "sources" TO fibuki_app;
