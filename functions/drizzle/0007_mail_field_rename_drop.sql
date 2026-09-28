-- #102 Mail Provider neutral field names, step 1 of 2: drop the Gmail-named
-- dedup columns (generated, so no stored data is lost — they derive from the
-- JSONB payload). Step 2 (0008) adds the neutral columns; the payload keys
-- themselves are renamed by the idempotent data step in db/migrate.ts, which
-- runs after migrations and recomputes the new columns via the UPDATE.
DROP INDEX "files_tenant_id_user_id_gmail_message_id_idx";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "gmail_message_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "gmail_attachment_id";