import { toDateSafe } from "@/lib/utils";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  doc,
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  UVAReport,
  ReportPeriod,
  ReportReadiness,
  ReportBlockingIssue,
  ReportSummary,
  getPeriodDateRange,
} from "@/types/report";
import { Transaction } from "@/types/transaction";

/**
 * Get transactions for a specific period
 */
async function getTransactionsForPeriod(
  ctx: OperationsContext,
  period: ReportPeriod
): Promise<Transaction[]> {
  const { start, end } = getPeriodDateRange(period);

  console.log("[report-ops] getTransactionsForPeriod:", {
    userId: ctx.userId,
    period,
    dateRange: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    startTimestamp: Timestamp.fromDate(start),
    endTimestamp: Timestamp.fromDate(end),
  });

  try {
    // Transactions are at root level with userId field (not nested under /users/)
    const q = query(
      collection(ctx.db, "transactions"),
      where("userId", "==", ctx.userId),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
      orderBy("date", "asc")
    );

    const snapshot = await getDocs(q);
    console.log("[report-ops] Found transactions:", snapshot.size);

    if (snapshot.size === 0) {
      // Debug: Try getting all transactions to see what dates exist
      const allTxQuery = query(
        collection(ctx.db, "transactions"),
        where("userId", "==", ctx.userId),
        orderBy("date", "desc")
      );
      const allSnapshot = await getDocs(allTxQuery);
      console.log("[report-ops] Total transactions in DB:", allSnapshot.size);
      if (allSnapshot.size > 0) {
        const sampleDates = allSnapshot.docs.slice(0, 5).map(d => {
          const data = d.data();
          return {
            id: d.id,
            date: data.date,
            dateType: typeof data.date,
            dateToDate: toDateSafe(data.date),
          };
        });
        console.log("[report-ops] Sample transaction dates:", sampleDates);
      }
    }

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Transaction[];
  } catch (error) {
    console.error("[report-ops] Error querying transactions:", error);
    throw error;
  }
}

/**
 * Check if all transactions are ready for reporting
 */
export async function getReportReadiness(
  ctx: OperationsContext,
  period: ReportPeriod
): Promise<ReportReadiness> {
  const transactions = await getTransactionsForPeriod(ctx, period);

  const totalTransactions = transactions.length;
  const incompleteTransactionIds: string[] = [];
  const blockingIssues: ReportBlockingIssue[] = [];

  // Track issues
  const missingReceipts: string[] = [];
  const missingPartners: string[] = [];

  for (const tx of transactions) {
    // Check if complete (has file or no-receipt category)
    if (!tx.isComplete) {
      incompleteTransactionIds.push(tx.id);
      missingReceipts.push(tx.id);
    }

    // Check if partner is assigned (for significant amounts)
    if (Math.abs(tx.amount) > 10000 && !tx.partnerId) {
      // > 100 EUR
      missingPartners.push(tx.id);
    }
  }

  // Build blocking issues
  if (missingReceipts.length > 0) {
    blockingIssues.push({
      type: "missing_receipt",
      message: `${missingReceipts.length} transactions missing receipts or categories`,
      transactionIds: missingReceipts,
      count: missingReceipts.length,
    });
  }

  if (missingPartners.length > 0) {
    blockingIssues.push({
      type: "missing_partner",
      message: `${missingPartners.length} transactions over 100 EUR missing partner information`,
      transactionIds: missingPartners,
      count: missingPartners.length,
    });
  }

  const completeTransactions = totalTransactions - incompleteTransactionIds.length;
  const completionPercentage =
    totalTransactions > 0 ? Math.round((completeTransactions / totalTransactions) * 100) : 100;

  return {
    isReady: blockingIssues.length === 0,
    totalTransactions,
    completeTransactions,
    incompleteTransactions: incompleteTransactionIds.length,
    incompleteTransactionIds,
    completionPercentage,
    blockingIssues,
  };
}

/**
 * Get a report by ID
 */
export async function getReport(
  ctx: OperationsContext,
  reportId: string
): Promise<UVAReport | null> {
  const docRef = doc(ctx.db, `users/${ctx.userId}/reports`, reportId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() } as UVAReport;
}

/**
 * List all reports for a user
 */
export async function listReports(
  ctx: OperationsContext,
  options: { limit?: number } = {}
): Promise<ReportSummary[]> {
  const q = query(
    collection(ctx.db, `users/${ctx.userId}/reports`),
    orderBy("period.year", "desc"),
    orderBy("period.period", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => {
    const data = doc.data() as UVAReport;
    return {
      id: doc.id,
      period: data.period,
      country: data.country,
      status: data.status,
      vatBalance: data.vatBalance,
      transactionCount: data.transactionCount.total,
      completionPercentage:
        data.transactionCount.total > 0
          ? Math.round(
              (data.transactionCount.complete / data.transactionCount.total) * 100
            )
          : 100,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as ReportSummary;
  });
}

/**
 * Check if a report exists for a period
 */
export async function getReportForPeriod(
  ctx: OperationsContext,
  period: ReportPeriod
): Promise<UVAReport | null> {
  const q = query(
    collection(ctx.db, `users/${ctx.userId}/reports`),
    where("period.year", "==", period.year),
    where("period.period", "==", period.period),
    where("period.type", "==", period.type)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as UVAReport;
}
