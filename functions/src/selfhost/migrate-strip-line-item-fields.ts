/**
 * #254: one-shot backfill that drops the two dead fields — `quantity` and
 * `unitPrice` — from every stored file's `extractedLineItems`.
 *
 * #252 (commit f536106c) stopped writing them: the extracted Line Item shape
 * is now `{ description, vatPercent, vatAmount, amount }`, because every tax
 * consumer collapses the rows to `{rate, gross, vat}` grouped by VAT rate and
 * nothing ever computed with the two dropped fields. This pass cleans out
 * what extraction wrote before that landed.
 *
 * Postgres only, deliberately. This module imports `firebase-admin/firestore`
 * the way every selfhost script does — resolved by vitest.selfhost.config.ts
 * (and the equivalent alias for the CLI entry) to the Postgres-backed shim —
 * so it only ever reaches the self-host store. It is never wired into
 * functions/src/index.ts and never deployed as a Cloud Function, so it can
 * never run against the retained Firebase project, which stays the rollback
 * anchor for the soak window exactly as it is (#227): a rollback anchor you
 * have mutated is not an anchor.
 *
 * Idempotent: a document whose line items already carry only the four
 * surviving fields has nothing to strip, so a second run touches nothing and
 * writes nothing.
 *
 * A backup precedes the write: the pre-image of every `extractedLineItems`
 * array about to be rewritten is captured to a JSON file before any update is
 * issued, so a bad run can be undone without a full pg_dump/restore cycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";

interface BackupEntry {
  id: string;
  extractedLineItems: unknown;
}

/**
 * Strip `quantity`/`unitPrice` from one stored line item. Not typed as
 * ExtractedLineItem going in — these are old, pre-#252 rows on disk, so the
 * shape can carry the two dead fields the current type no longer declares.
 */
function stripRow(raw: unknown): { changed: boolean; item: unknown } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { changed: false, item: raw };
  }
  const row = raw as Record<string, unknown>;
  if (!("quantity" in row) && !("unitPrice" in row)) {
    return { changed: false, item: row };
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "quantity" || key === "unitPrice") continue;
    stripped[key] = value;
  }
  return { changed: true, item: stripped };
}

export interface StripLineItemFieldsReport {
  /** Total file documents inspected. */
  documentsScanned: number;
  /** Documents whose extractedLineItems actually changed. */
  documentsTouched: number;
  /** Individual line-item rows that had quantity/unitPrice removed. */
  rowsRewritten: number;
  /** Path of the pre-write backup, or null when there was nothing to back up. */
  backupPath: string | null;
}

export interface StripLineItemFieldsOptions {
  dryRun?: boolean;
  /** Directory the backup JSON is written into. Required unless dryRun. */
  backupDir: string;
  log?: (line: string) => void;
}

export async function stripLineItemFields(
  opts: StripLineItemFieldsOptions,
): Promise<StripLineItemFieldsReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = getFirestore();
  const snap = await db.collection("files").get();

  const backups: BackupEntry[] = [];
  const updates: Array<{ ref: { update(d: Record<string, unknown>): Promise<unknown> }; items: unknown[] }> = [];
  let rowsRewritten = 0;

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    const items = data?.extractedLineItems;
    if (!Array.isArray(items) || items.length === 0) continue;

    let touchedRows = 0;
    const rewritten = items.map((raw) => {
      const { changed, item } = stripRow(raw);
      if (changed) touchedRows++;
      return item;
    });

    if (touchedRows === 0) continue;

    backups.push({ id: doc.id, extractedLineItems: items });
    updates.push({ ref: doc.ref, items: rewritten });
    rowsRewritten += touchedRows;
  }

  let backupPath: string | null = null;
  if (!opts.dryRun && backups.length > 0) {
    await fs.mkdir(opts.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir, `strip-line-item-fields-${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(backups, null, 2));
    log(`  backup: ${backups.length} document(s) written to ${backupPath}`);
  }

  if (!opts.dryRun) {
    for (const u of updates) {
      await u.ref.update({ extractedLineItems: u.items });
    }
  }

  log(
    `  files: ${updates.length}/${snap.size} documents touched, ${rowsRewritten} row(s) rewritten` +
      (opts.dryRun ? " (dry run — nothing written, no backup taken)" : ""),
  );

  return {
    documentsScanned: snap.size,
    documentsTouched: updates.length,
    rowsRewritten,
    backupPath,
  };
}
