/**
 * One-off pass: restate stored NET line items in the gross form every reader
 * of `extractedLineItems` assumes.
 *
 * Extraction converted net rows to gross only on documents without a printed
 * VAT summary block. With a block, the per-group check accepted a group as
 * gross or as net plus VAT, so net rows reconciled and were stored net: the
 * row editor showed the VAT as a delta and the file view showed the net figure
 * as the row's amount. Reconciliation now grosses them up against the block;
 * this pass brings the Files extracted before that in line, without a model
 * call.
 *
 * It runs today's reconciliation over the stored rows and writes the result
 * only when the sole difference is net rows restated as gross: the same rows,
 * each row's net (amount minus VAT) unchanged, and the reconciliation flag
 * unchanged. Anything more (a summary row today's rules would drop, a VAT
 * re-split, a flag that would flip) is left for a re-extraction to decide.
 * The document's own figures (total, VAT, rate groups) are never touched.
 *
 * A File a person corrected by hand is skipped and named in the report: the
 * person outranks any pass, and they can check the row themselves.
 *
 * Postgres only, for the reason the strip pass beside it gives: it is never
 * wired into functions/src/index.ts, so it cannot reach the retained Firebase
 * project. Idempotent: a second run finds the rows gross and writes nothing.
 * A backup of every array about to be rewritten is written before any update.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import {
  reconcileLineItemsWithDocumentTotal,
  totalWithoutPrintedTip,
} from "../extraction/lineItemReconciliation";
import { hasHandCorrections } from "../fileFacts/provenance";
import type { ExtractedLineItem, ExtractedRateGroup } from "../types/extraction";

interface BackupEntry {
  id: string;
  extractedLineItems: unknown;
}

/**
 * The rows today's reconciliation would store, when they differ from the
 * stored ones only by net rows restated as gross; otherwise null.
 */
function grossedUpRows(data: Record<string, unknown>): ExtractedLineItem[] | null {
  const stored = data.extractedLineItems as ExtractedLineItem[];
  const rateGroups = data.extractedRateGroups as ExtractedRateGroup[] | null | undefined;
  if (!Array.isArray(rateGroups) || rateGroups.length === 0) return null;

  const result = reconcileLineItemsWithDocumentTotal(
    stored,
    totalWithoutPrintedTip(
      data.extractedAmount as number | null | undefined,
      data.extractedTipAmount as number | null | undefined,
      rateGroups
    ),
    rateGroups,
    data.extractedVatPercent as number | null | undefined
  );

  if (result.unreconciled !== Boolean(data.lineItemsUnreconciled)) return null;
  if (result.lineItems.length !== stored.length) return null;

  let grossedUp = 0;
  for (let i = 0; i < stored.length; i++) {
    const before = stored[i];
    const after = result.lineItems[i];
    if (after.description !== before.description) return null;
    if (after.amount === before.amount && after.vatAmount === before.vatAmount) continue;
    if (after.amount - after.vatAmount !== before.amount || after.vatAmount <= 0) return null;
    grossedUp++;
  }
  return grossedUp > 0 ? result.lineItems : null;
}

export interface GrossUpNetLineItemsReport {
  /** Total file documents inspected. */
  documentsScanned: number;
  /** Documents whose rows were (or, on a dry run, would be) restated. */
  documentsTouched: number;
  /** Files with net rows the pass left alone because a person corrected them. */
  skippedHandCorrected: string[];
  /** Path of the pre-write backup, or null when there was nothing to back up. */
  backupPath: string | null;
}

export interface GrossUpNetLineItemsOptions {
  dryRun?: boolean;
  /** Directory the backup JSON is written into. Required unless dryRun. */
  backupDir: string;
  log?: (line: string) => void;
}

export async function grossUpNetLineItems(
  opts: GrossUpNetLineItemsOptions,
): Promise<GrossUpNetLineItemsReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = getFirestore();
  const snap = await db.collection("files").get();

  const backups: BackupEntry[] = [];
  const updates: Array<{ id: string; ref: { update(d: Record<string, unknown>): Promise<unknown> }; items: ExtractedLineItem[] }> = [];
  const skippedHandCorrected: string[] = [];

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    const items = data?.extractedLineItems;
    if (!data || !Array.isArray(items) || items.length === 0) continue;

    const rows = grossedUpRows(data);
    if (!rows) continue;
    if (hasHandCorrections(data)) {
      skippedHandCorrected.push(doc.id);
      continue;
    }

    backups.push({ id: doc.id, extractedLineItems: items });
    updates.push({ id: doc.id, ref: doc.ref, items: rows });
  }

  let backupPath: string | null = null;
  if (!opts.dryRun && backups.length > 0) {
    await fs.mkdir(opts.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir, `gross-up-net-line-items-${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(backups, null, 2));
    log(`  backup: ${backups.length} document(s) written to ${backupPath}`);
  }

  for (const u of updates) {
    log(`  ${opts.dryRun ? "would restate" : "restated"} ${u.id}`);
    if (!opts.dryRun) {
      await u.ref.update({ extractedLineItems: u.items });
    }
  }
  for (const id of skippedHandCorrected) {
    log(`  skipped ${id}: corrected by hand`);
  }

  log(
    `  files: ${updates.length}/${snap.size} documents touched, ` +
      `${skippedHandCorrected.length} skipped as hand-corrected` +
      (opts.dryRun ? " (dry run — nothing written, no backup taken)" : ""),
  );

  return {
    documentsScanned: snap.size,
    documentsTouched: updates.length,
    skippedHandCorrected,
    backupPath,
  };
}
