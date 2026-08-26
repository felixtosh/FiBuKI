import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  UVAReport,
  ReportPeriod,
  ReportReadiness,
  ReportBlockingIssue,
  ReportSummary,
  VatBreakdown,
  getPeriodDateRange,
} from "@/types/report";
import { Transaction } from "@/types/transaction";
import { TaxCountryCode } from "@/types/user-data";

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
            dateToDate: data.date?.toDate?.(),
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
 * Calculate UVA report from transactions
 *
 * @deprecated Fork #64: this browser-side calculation assumes 20% VAT on
 * every transaction and never reads the connected receipts — its figures
 * are wrong by construction. The reports page now calls the server-side
 * calculateUva callable (functions/src/uva) via POST /api/reports/calculate.
 * Only createUVADraft/recalculateReport below still reference this; both
 * are themselves unused from the UI.
 */
export async function calculateUVAReport(
  ctx: OperationsContext,
  period: ReportPeriod,
  country: TaxCountryCode = "AT"
): Promise<Omit<UVAReport, "id" | "createdAt" | "updatedAt">> {
  const transactions = await getTransactionsForPeriod(ctx, period);

  // Initialize totals
  const taxableRevenue = {
    rate20Net: 0,
    rate20Vat: 0,
    rate10Net: 0,
    rate10Vat: 0,
    rate13Net: 0,
    rate13Vat: 0,
  };

  const exemptRevenue = {
    exports: 0,
    euDeliveries: 0,
    other: 0,
  };

  const euAcquisitions = {
    netAmount: 0,
    vatAmount: 0,
  };

  const inputVat = {
    standard: 0,
    euAcquisitions: 0,
    imports: 0,
  };

  // Track breakdown by rate
  const breakdownMap = new Map<number, VatBreakdown>();

  // Count transactions
  let incomeCount = 0;
  let expenseCount = 0;
  let completeCount = 0;

  for (const tx of transactions) {
    const isIncome = tx.amount > 0;
    const amount = Math.abs(tx.amount);

    if (isIncome) {
      incomeCount++;
    } else {
      expenseCount++;
    }

    if (tx.isComplete) {
      completeCount++;
    }

    // Default VAT rate based on transaction type
    // In reality, this would come from the linked file/invoice
    const vatRate = tx.vatRate ?? (isIncome ? 20 : 20);

    // Calculate net and VAT amounts
    // Assuming amounts are gross (including VAT)
    const grossAmount = amount;
    const netAmount = Math.round(grossAmount / (1 + vatRate / 100));
    const vatAmount = grossAmount - netAmount;

    if (isIncome) {
      // Revenue
      switch (vatRate) {
        case 20:
          taxableRevenue.rate20Net += netAmount;
          taxableRevenue.rate20Vat += vatAmount;
          break;
        case 13:
          taxableRevenue.rate13Net += netAmount;
          taxableRevenue.rate13Vat += vatAmount;
          break;
        case 10:
          taxableRevenue.rate10Net += netAmount;
          taxableRevenue.rate10Vat += vatAmount;
          break;
        case 0:
          // Check if it's an export or EU delivery
          if (tx.isEuTransaction) {
            exemptRevenue.euDeliveries += netAmount;
          } else {
            exemptRevenue.other += netAmount;
          }
          break;
      }
    } else {
      // Expense - add to input VAT
      if (tx.isEuTransaction) {
        // EU acquisition (reverse charge)
        euAcquisitions.netAmount += netAmount;
        euAcquisitions.vatAmount += vatAmount;
        inputVat.euAcquisitions += vatAmount;
      } else {
        inputVat.standard += vatAmount;
      }
    }

    // Update breakdown
    const existing = breakdownMap.get(vatRate);
    if (existing) {
      existing.netAmount += netAmount;
      existing.vatAmount += vatAmount;
      existing.grossAmount += grossAmount;
      existing.transactionCount += 1;
    } else {
      breakdownMap.set(vatRate, {
        rate: vatRate,
        netAmount,
        vatAmount,
        grossAmount,
        transactionCount: 1,
      });
    }
  }

  // Calculate totals
  const totalVatPayable =
    taxableRevenue.rate20Vat +
    taxableRevenue.rate10Vat +
    taxableRevenue.rate13Vat +
    euAcquisitions.vatAmount;

  const totalInputVat =
    inputVat.standard + inputVat.euAcquisitions + inputVat.imports;

  const vatBalance = totalVatPayable - totalInputVat;

  return {
    userId: ctx.userId,
    period,
    country,
    status: "draft",
    taxableRevenue,
    exemptRevenue,
    euAcquisitions,
    inputVat,
    totalVatPayable,
    totalInputVat,
    vatBalance,
    breakdown: Array.from(breakdownMap.values()).sort((a, b) => b.rate - a.rate),
    transactionCount: {
      total: transactions.length,
      income: incomeCount,
      expense: expenseCount,
      complete: completeCount,
      incomplete: transactions.length - completeCount,
    },
  };
}

/**
 * Create a draft UVA report
 */
export async function createUVADraft(
  ctx: OperationsContext,
  period: ReportPeriod,
  country: TaxCountryCode = "AT"
): Promise<string> {
  const reportData = await calculateUVAReport(ctx, period, country);

  const now = Timestamp.now();
  const docRef = await addDoc(collection(ctx.db, `users/${ctx.userId}/reports`), {
    ...reportData,
    createdAt: now,
    updatedAt: now,
  });

  return docRef.id;
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
 * Update report status
 */
export async function updateReportStatus(
  ctx: OperationsContext,
  reportId: string,
  status: UVAReport["status"],
  finanzonlineRef?: string
): Promise<void> {
  const docRef = doc(ctx.db, `users/${ctx.userId}/reports`, reportId);
  const updates: Record<string, unknown> = {
    status,
    updatedAt: Timestamp.now(),
  };

  if (status === "submitted") {
    updates.submittedAt = Timestamp.now();
  }

  if (finanzonlineRef) {
    updates.finanzonlineRef = finanzonlineRef;
  }

  await updateDoc(docRef, updates);
}

/**
 * Recalculate an existing report
 */
export async function recalculateReport(
  ctx: OperationsContext,
  reportId: string
): Promise<void> {
  const existingReport = await getReport(ctx, reportId);
  if (!existingReport) {
    throw new Error("Report not found");
  }

  const reportData = await calculateUVAReport(
    ctx,
    existingReport.period,
    existingReport.country
  );

  const docRef = doc(ctx.db, `users/${ctx.userId}/reports`, reportId);
  await updateDoc(docRef, {
    ...reportData,
    status: "draft", // Reset to draft when recalculating
    updatedAt: Timestamp.now(),
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
