CREATE TABLE "trigger_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collection_path" text NOT NULL,
	"doc_id" text NOT NULL,
	"path" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_events_pending_idx" ON "trigger_events" USING btree ("tenant_id","claimed_at","seq");--> statement-breakpoint
-- Hand-appended: drizzle-kit does not emit RLS. FORCE is required because the
-- selfhost deployment and the tests connect as the table owner.
ALTER TABLE "trigger_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trigger_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "trigger_events"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "trigger_events" TO fibuki_app;--> statement-breakpoint
-- bigserial: the app role also needs the sequence, or every enqueue fails with
-- "permission denied for sequence trigger_events_seq_seq".
GRANT USAGE, SELECT ON SEQUENCE "trigger_events_seq_seq" TO fibuki_app;