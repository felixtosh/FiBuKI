CREATE TABLE "extraction_jobs" (
	"tenant_id" uuid NOT NULL,
	"file_id" text NOT NULL,
	"user_id" text NOT NULL,
	"skip_classification" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"rerun" boolean DEFAULT false NOT NULL,
	"reset_on_claim" boolean DEFAULT false NOT NULL,
	CONSTRAINT "extraction_jobs_tenant_id_file_id_pk" PRIMARY KEY("tenant_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "extraction_turns" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_claimed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "extraction_turns_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_turns" ADD CONSTRAINT "extraction_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_jobs_waiting_idx" ON "extraction_jobs" USING btree ("tenant_id","claimed_at","created_at");--> statement-breakpoint
-- Hand-appended: drizzle-kit does not emit RLS. FORCE is required because the
-- selfhost deployment and the tests connect as the table owner.
ALTER TABLE "extraction_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extraction_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "extraction_jobs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extraction_jobs" TO fibuki_app;--> statement-breakpoint
ALTER TABLE "extraction_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extraction_turns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "extraction_turns"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extraction_turns" TO fibuki_app;
