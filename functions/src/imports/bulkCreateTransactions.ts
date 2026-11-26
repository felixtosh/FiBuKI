/**
 * Bulk create transactions from a CSV import
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { checkTransactionQuota, incrementTransactionCount } from "../billing/checkTransactionQuota";
import { toDateSafe } from "../utils/toDateSafe";
import { normalizeTransactionType } from "./transactionType";
import { computeDedupeHash, splitDuplicates } from "./dedupe";
import { readExternalRowId } from "./externalRowId";
import { readFiscalYears, splitUntracked, stretchOf } from "../fiscalYears/fiscalYears";

interface TransactionData {
  sourceId: string;
  date: string; // ISO string
  amount: number; // in cents
  currency: string;
  name: string;
  description?: string | null;
  partner?: string | null;
  reference?: string | null;
  partnerIban?: string | null;
  /** The bank's own type wording from the mapped column, raw (#136). */
  bankTransactionType?: string | null;
  /** Ignored. The server derives the hash itself (imports/dedupe.ts), so no client can drift from it. */
  dedupeHash?: string;
  /**
   * The External Row Id (#804): the row's value of the Reference / Transaction ID
   * column, sent only when the whole file's column is one (externalRowIdsFromReferences).
   */
  externalRowId?: unknown;
  importJobId: string;
  csvRowIndex?: number;
  _original: {
    date: string;
    amount: string;
    rawRow: Record<string, string>;
  };
}

interface BalanceInfo {
  openingBalance: number; // in cents
  openingBalanceDate: string; // ISO string
  latestBalance: number; // in cents
  latestBalanceDate: string; // ISO string
}

interface BulkCreateTransactionsRequest {
  transactions: TransactionData[];
  sourceId: string;
  balanceInfo?: BalanceInfo;
}

interface BulkCreateTransactionsResponse {
  success: boolean;
  transactionIds: string[];
  count: number;
  /** Rows an earlier import already stored for this Bank Account; not written. */
  duplicateCount: number;
  /** Rows before Tracked From (#794); not written. */
  untrackedCount?: number;
  /** The same rows per fiscal year (`2023`, or `2023/24`). */
  untrackedByFiscalYear?: Record<string, number>;
  quotaExceeded: boolean;
  overLimitCount: number;
  overLimitTransactionIds: string[];
}

const BATCH_SIZE = 500; // Firestore batch limit

export const bulkCreateTransactionsCallable = createCallable<
  BulkCreateTransactionsRequest,
  BulkCreateTransactionsResponse
>(
  {
    name: "bulkCreateTransactions",
    timeoutSeconds: 300, // 5 minutes for large imports
    memory: "1GiB",
  },
  async (ctx, request) => {
    const { transactions, sourceId } = request;

    if (!transactions || !Array.isArray(transactions)) {
      throw new HttpsError("invalid-argument", "transactions array is required");
    }

    if (!sourceId) {
      throw new HttpsError("invalid-argument", "sourceId is required");
    }

    if (transactions.length === 0) {
      return { success: true, transactionIds: [], count: 0, duplicateCount: 0, quotaExceeded: false, overLimitCount: 0, overLimitTransactionIds: [] };
    }

    if (transactions.length > 5000) {
      throw new HttpsError(
        "invalid-argument",
        "Cannot import more than 5000 transactions at once"
      );
    }

    // Verify source ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();

    if (!sourceSnap.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    if (sourceSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Source access denied");
    }

    // Skip what an earlier import already holds, decided here and nowhere else. The hash
    // is the Bank Account's IBAN (or its id when it has none) with date, amount and reference.
    const sourceIdentifier = (sourceSnap.data()!.iban as string | undefined) || sourceId;
    const importJobId = transactions[0].importJobId;
    const hashed = transactions.map((tx, index) => {
      if (isNaN(new Date(tx.date).getTime())) {
        throw new HttpsError("invalid-argument", `Invalid date for transaction: ${tx.date}`);
      }
      // The External Row Id from the Reference / Transaction ID column, when the browser
      // found that column to be one (imports/externalRowId.ts, #804).
      let externalRowId: string | null;
      try {
        externalRowId = readExternalRowId(tx.externalRowId, index);
      } catch (error) {
        throw new HttpsError("invalid-argument", (error as Error).message);
      }
      return {
        ...tx,
        externalRowId,
        dedupeHash: computeDedupeHash({
          date: tx.date,
          amount: tx.amount,
          sourceIdentifier,
          reference: tx.reference,
        }),
      };
    });
    // Rows before Tracked From are skipped and counted per fiscal year (#794).
    const { tracked, ...untracked } = await splitUntracked(ctx.db, ctx.userId, hashed, (tx) => tx.date);
    const trackedRows = new Set(tracked);
    const skippedSum = hashed.filter((tx) => !trackedRows.has(tx)).reduce((sum, tx) => sum + (tx.amount ?? 0), 0);

    // Persist balance info on the source. A Cash Box keeps none (#787): a CSV
    // of cash payments says nothing about what is in the box. Only the first
    // chunk of a file carries balanceInfo.
    //
    // The browser derives the opening balance from the file's earliest row.
    // When that row lies before Tracked From, the rows up to Tracked From are
    // skipped (#794), so the stored opening carries the file's opening past
    // them and is dated at Tracked From: every stored row of the file comes
    // after it. A later chunk of the same Import adds its own skipped rows.
    const persistBalance = async () => {
      const sourceData = sourceSnap.data()!;
      if (sourceData.accountKind === "cash") return;
      if (!request.balanceInfo) {
        if (skippedSum !== 0 && importJobId && sourceData.openingBalanceImportJobId === importJobId) {
          await sourceRef.update({ openingBalance: FieldValue.increment(skippedSum), updatedAt: Timestamp.now() });
        }
        return;
      }
      const { openingBalance, openingBalanceDate, latestBalance, latestBalanceDate } = request.balanceInfo;
      const existingOpeningDate = toDateSafe(sourceData.openingBalanceDate);
      const settings = await readFiscalYears(ctx.db, ctx.userId);
      const fileOpeningDate = new Date(openingBalanceDate);
      const carried = stretchOf(settings, fileOpeningDate) === "untracked";
      const newOpeningDate = carried ? new Date(`${settings.trackedFrom}-01T00:00:00Z`) : fileOpeningDate;

      // Only update the opening balance if there is none or this one is earlier.
      const shouldUpdateOpening = !existingOpeningDate || newOpeningDate < existingOpeningDate;

      const balanceUpdates: Record<string, unknown> = {
        latestBalance,
        latestBalanceDate: Timestamp.fromDate(new Date(latestBalanceDate)),
        updatedAt: Timestamp.now(),
      };
      if (shouldUpdateOpening) {
        balanceUpdates.openingBalance = openingBalance + (carried ? skippedSum : 0);
        balanceUpdates.openingBalanceDate = Timestamp.fromDate(newOpeningDate);
        balanceUpdates.openingBalanceSource = "csv_derived";
        balanceUpdates.openingBalanceImportJobId = carried && importJobId ? importJobId : null;
      }

      await sourceRef.update(balanceUpdates);
      console.log(`[bulkCreateTransactions] Updated balance info on source ${sourceId}`, {
        shouldUpdateOpening,
        openingBalance,
        latestBalance,
      });
    };
    const { fresh, duplicates } = await splitDuplicates(ctx.db, ctx.userId, sourceId, tracked, importJobId);
    const duplicateCount = duplicates.length;

    if (fresh.length === 0) {
      await persistBalance();
      return { success: true, transactionIds: [], count: 0, duplicateCount, ...untracked, quotaExceeded: false, overLimitCount: 0, overLimitTransactionIds: [] };
    }

    // Check transaction quota (soft limit — import all, mark over-limit ones)
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const quota = await checkTransactionQuota(ctx.userId, fresh.length, isAdmin);
    const overLimitStartIndex = quota.allowed ? fresh.length : quota.remainingSlots;

    const now = Timestamp.now();
    const transactionIds: string[] = [];
    const overLimitTransactionIds: string[] = [];

    // Process in batches
    let globalIndex = 0;
    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      const batch = ctx.db.batch();
      const chunk = fresh.slice(i, i + BATCH_SIZE);

      for (const txData of chunk) {
        const docRef = ctx.db.collection("transactions").doc();
        transactionIds.push(docRef.id);

        const isOverLimit = globalIndex >= overLimitStartIndex;
        if (isOverLimit) {
          overLimitTransactionIds.push(docRef.id);
        }

        // Convert ISO date string to Timestamp
        const date = new Date(txData.date);
        if (isNaN(date.getTime())) {
          throw new HttpsError(
            "invalid-argument",
            `Invalid date for transaction: ${txData.date}`
          );
        }

        // Normalize to UTC midnight — safety net for any timezone drift in the incoming ISO string
        const utcMidnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

        const transactionDoc: Record<string, unknown> = {
          userId: ctx.userId,
          sourceId: txData.sourceId,
          date: Timestamp.fromDate(utcMidnight),
          amount: txData.amount,
          currency: txData.currency,
          name: txData.name,
          description: txData.description ?? null,
          partner: txData.partner ?? null,
          reference: txData.reference ?? null,
          partnerIban: txData.partnerIban ?? null,
          transactionType: normalizeTransactionType(txData.bankTransactionType),
          dedupeHash: txData.dedupeHash,
          ...(txData.externalRowId ? { externalRowId: txData.externalRowId } : {}),
          importJobId: txData.importJobId,
          csvRowIndex: txData.csvRowIndex,
          _original: txData._original,
          // Default values
          fileIds: [],
          isComplete: false,
          partnerId: null,
          partnerType: null,
          partnerMatchConfidence: null,
          partnerMatchedBy: null,
          noReceiptCategoryId: null,
          createdAt: now,
          updatedAt: now,
        };

        if (isOverLimit) {
          transactionDoc.quotaExceeded = true;
        }

        batch.set(docRef, transactionDoc);
        globalIndex++;
      }

      await batch.commit();
    }

    const quotaExceeded = overLimitTransactionIds.length > 0;

    console.log(`[bulkCreateTransactions] Created ${transactionIds.length} transactions` +
      (quotaExceeded ? ` (${overLimitTransactionIds.length} over quota)` : ""), {
      userId: ctx.userId,
      sourceId,
    });

    await persistBalance();

    // Only count within-quota transactions for billing
    const withinQuotaCount = transactionIds.length - overLimitTransactionIds.length;
    if (withinQuotaCount > 0) {
      incrementTransactionCount(ctx.userId, withinQuotaCount).catch((err) =>
        console.error("[bulkCreateTransactions] Failed to increment transaction count:", err)
      );
    }

    return {
      success: true,
      transactionIds,
      count: transactionIds.length,
      duplicateCount,
      ...untracked,
      quotaExceeded,
      overLimitCount: overLimitTransactionIds.length,
      overLimitTransactionIds,
    };
  }
);
