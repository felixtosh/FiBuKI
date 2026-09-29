/**
 * #136: one-shot backfill of `transactionType` on Transactions imported before
 * it existed. The bank's own wording is still in `_original.rawRow`, under the
 * CSV column the Source mapped to "category" (`fieldMappings.mappings`), so
 * the type is derived exactly as bulkCreateTransactions derives it at Import.
 *
 * A Transaction whose Source mapped no type column is left without the field;
 * one whose wording is unknown gets null, the value Import writes for it.
 * A type already set is never overwritten, which also makes a second run a
 * no-op.
 *
 * Dry run unless `apply` is set. Postgres only, never wired into index.ts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { normalizeTransactionType, TransactionType } from "../imports/transactionType";

export interface MigrateTransactionTypeReport {
  transactionsScanned: number;
  /** Transactions that get a canonical type. */
  typed: Array<{ id: string; transactionType: TransactionType }>;
  /** Transactions whose bank wording is unknown; they get null. */
  unknown: string[];
  /** Transactions skipped because their Source mapped no type column. */
  noMapping: number;
  backupPath: string | null;
  applied: boolean;
}

export interface MigrateTransactionTypeOptions {
  apply?: boolean;
  userId?: string;
  backupDir?: string;
  log?: (line: string) => void;
}

/** The CSV header a Source's saved mapping sends to the bank-type field. */
function typeColumnOf(source: Record<string, unknown> | undefined): string | null {
  const mappings = (source?.fieldMappings as { mappings?: Record<string, string> } | undefined)?.mappings;
  if (!mappings) return null;
  const entry = Object.entries(mappings).find(([, field]) => field === "category");
  return entry ? entry[0] : null;
}

export async function migrateTransactionType(
  opts: MigrateTransactionTypeOptions = {},
): Promise<MigrateTransactionTypeReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.apply && !opts.backupDir) {
    throw new Error("backupDir is required when applying");
  }

  const db = getFirestore();
  const sources = opts.userId
    ? await db.collection("sources").where("userId", "==", opts.userId).get()
    : await db.collection("sources").get();
  const columnBySource = new Map<string, string | null>();
  for (const doc of sources.docs) {
    columnBySource.set(doc.id, typeColumnOf(doc.data() as Record<string, unknown>));
  }

  const txs = opts.userId
    ? await db.collection("transactions").where("userId", "==", opts.userId).get()
    : await db.collection("transactions").get();

  const typed: MigrateTransactionTypeReport["typed"] = [];
  const unknown: string[] = [];
  let noMapping = 0;
  const updates: Array<{ ref: (typeof txs.docs)[number]["ref"]; type: TransactionType | null }> = [];

  for (const doc of txs.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    if ("transactionType" in data) continue;
    const column = columnBySource.get(String(data.sourceId)) ?? null;
    if (!column) {
      noMapping++;
      continue;
    }
    const rawRow = (data._original as { rawRow?: Record<string, string> } | undefined)?.rawRow;
    const type = normalizeTransactionType(rawRow?.[column]);
    if (type) typed.push({ id: doc.id, transactionType: type });
    else unknown.push(doc.id);
    updates.push({ ref: doc.ref, type });
  }

  const counts = new Map<string, number>();
  for (const t of typed) counts.set(t.transactionType, (counts.get(t.transactionType) ?? 0) + 1);
  for (const [type, n] of counts) log(`  ${type}: ${n}`);
  log(`  unknown wording: ${unknown.length}`);

  let backupPath: string | null = null;
  if (opts.apply && updates.length > 0) {
    await fs.mkdir(opts.backupDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir!, `transaction-type-${stamp}.json`);
    // Every rewritten Transaction had no transactionType; the ids are the undo.
    await fs.writeFile(backupPath, JSON.stringify(updates.map((u) => u.ref.id), null, 2));
    log(`  backup: ${updates.length} transaction id(s) written to ${backupPath}`);
    for (const u of updates) {
      await u.ref.update({ transactionType: u.type, updatedAt: FieldValue.serverTimestamp() });
    }
  }

  log(
    `  transactions: ${typed.length} typed, ${unknown.length} unknown, ${noMapping} without a type column, ` +
      `of ${txs.size} scanned` + (opts.apply ? "" : " (dry run, nothing written)"),
  );

  return {
    transactionsScanned: txs.size,
    typed,
    unknown,
    noMapping,
    backupPath,
    applied: !!opts.apply,
  };
}
