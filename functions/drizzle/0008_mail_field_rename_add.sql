-- #102 Mail Provider neutral field names, step 2 of 2: the neutral dedup
-- columns + index. Existing rows still carry the Gmail-named payload keys at
-- this point (so these compute NULL); db/migrate.ts renames the keys right
-- after migrations, and the UPDATE recomputes the generated columns.
ALTER TABLE "files" ADD COLUMN "mail_message_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'mailMessageId') = 'string' THEN "data"->'mailMessageId' #>> '{}' END) STORED;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "mail_attachment_id" text GENERATED ALWAYS AS (CASE WHEN jsonb_typeof("data"->'mailAttachmentId') = 'string' THEN "data"->'mailAttachmentId' #>> '{}' END) STORED;--> statement-breakpoint
CREATE INDEX "files_tenant_id_user_id_mail_message_id_idx" ON "files" USING btree ("tenant_id","user_id","mail_message_id");