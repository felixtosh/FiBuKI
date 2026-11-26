/**
 * A TrueLayer sync's write: the lines TrueLayer returned for one Bank Account,
 * stored through the server's Admin SDK (#813), never the client SDK. The two
 * TrueLayer routes (a sync, and the first sync after linking an account) both
 * write here, through the Import writer's splits: rows before Tracked From are
 * skipped and counted per fiscal year (#794), and a line the Bank Account
 * already stores, by External Row Id or by hash, is skipped (#804).
 *
 * Server only: it reaches `firebase-admin`, never `firebase-functions`.
 */

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { TrueLayerTransaction } from "@/types/truelayer";
import { transactionTypeFromRawRow } from "@/functions/src/imports/transactionType";
import { computeDedupeHash, splitDuplicates } from "@/functions/src/imports/dedupe";
import { splitUntracked } from "@/functions/src/fiscalYears/settings";

const BATCH_SIZE = 500;

export interface TrueLayerImportResult {
  /** Rows written. */
  imported: number;
  /** Rows the Bank Account already stores; not written. */
  skipped: number;
  /** Lines TrueLayer returned. */
  total: number;
  /** Rows before Tracked From (#794); not written. */
  untrackedCount: number;
  /** The same rows per fiscal year (`2023`, or `2023/24`). */
  untrackedByFiscalYear: Record<string, number>;
}

export async function importTrueLayerTransactions(
  db: Firestore,
  input: {
    userId: string;
    sourceId: string;
    /** What the dedupe hash names the Bank Account by: its IBAN, or what the caller stands in for it. */
    sourceIdentifier: string;
    transactions: TrueLayerTransaction[];
  }
): Promise<TrueLayerImportResult> {
  const { userId, sourceId, sourceIdentifier, transactions } = input;
  const now = Timestamp.now();

  const { tracked, untrackedCount, untrackedByFiscalYear } = await splitUntracked(
    db,
    userId,
    transactions,
    (tx) => new Date(tx.timestamp)
  );

  const candidates = tracked.map((tx) => {
    // TrueLayer returns whole currency units (42.50); amounts are stored in cents (4250).
    const cents = Math.round(Math.abs(tx.amount) * 100);
    const amount = tx.transaction_type === "CREDIT" ? cents : -cents;
    const txDate = new Date(tx.timestamp);
    const reference = tx.meta?.provider_reference || tx.transaction_id;
    const dedupeHash = computeDedupeHash({ date: txDate, amount, sourceIdentifier, reference });
    // TrueLayer's transaction id is the External Row Id (#804).
    return { tx, amount, txDate, reference, dedupeHash, externalRowId: tx.transaction_id };
  });

  const { fresh, duplicates } = await splitDuplicates(db, userId, sourceId, candidates);

  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { tx, amount, txDate, reference, dedupeHash, externalRowId } of fresh.slice(i, i + BATCH_SIZE)) {
      batch.set(db.collection("transactions").doc(), {
        sourceId,
        importJobId: null,
        userId,
        date: Timestamp.fromDate(txDate),
        amount,
        currency: tx.currency,
        name: tx.description,
        partner: tx.merchant_name || null,
        partnerIban: null,
        transactionType: transactionTypeFromRawRow(tx as unknown as Record<string, unknown>),
        description: null,
        reference,
        dedupeHash,
        externalRowId,
        _original: {
          date: tx.timestamp,
          amount: tx.amount.toString(),
          rawRow: tx as unknown as Record<string, string>,
        },
        // The defaults every Import writer stores.
        fileIds: [],
        isComplete: false,
        partnerId: null,
        partnerType: null,
        partnerMatchConfidence: null,
        partnerMatchedBy: null,
        noReceiptCategoryId: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await batch.commit();
  }

  await db.collection("sources").doc(sourceId).update({
    "apiConfig.lastSyncAt": now,
    updatedAt: now,
  });

  return {
    imported: fresh.length,
    skipped: duplicates.length,
    total: transactions.length,
    untrackedCount,
    untrackedByFiscalYear,
  };
}
