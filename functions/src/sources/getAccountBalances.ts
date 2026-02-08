/**
 * Get account balances across all sources at a specific date.
 * Used for tax reporting (e.g. Kontostand 31.12.)
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface GetAccountBalancesRequest {
  date: string; // ISO string, e.g. "2025-12-31"
}

interface AccountBalance {
  sourceId: string;
  sourceName: string;
  currency: string;
  accountKind: string;
  openingBalance: number;
  transactionSum: number;
  balanceAtDate: number;
}

interface GetAccountBalancesResponse {
  balances: AccountBalance[];
  date: string;
}

export const getAccountBalancesCallable = createCallable<
  GetAccountBalancesRequest,
  GetAccountBalancesResponse
>(
  { name: "getAccountBalances" },
  async (ctx, request) => {
    const { date } = request;

    if (!date) {
      throw new HttpsError("invalid-argument", "date is required");
    }

    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date format");
    }

    // Set to end of day
    targetDate.setHours(23, 59, 59, 999);

    // Get all active sources for the user
    const sourcesSnap = await ctx.db
      .collection("sources")
      .where("userId", "==", ctx.userId)
      .where("isActive", "==", true)
      .get();

    const balances: AccountBalance[] = [];

    for (const sourceDoc of sourcesSnap.docs) {
      const sourceData = sourceDoc.data();
      const openingBalance = sourceData.openingBalance ?? 0;
      const openingBalanceDate = sourceData.openingBalanceDate?.toDate();

      // Query transactions up to targetDate
      let query = ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
        .where("sourceId", "==", sourceDoc.id)
        .where("date", "<=", Timestamp.fromDate(targetDate));

      if (openingBalanceDate) {
        query = query.where("date", ">=", Timestamp.fromDate(openingBalanceDate));
      }

      const txSnap = await query.get();

      let transactionSum = 0;
      for (const doc of txSnap.docs) {
        transactionSum += doc.data().amount ?? 0;
      }

      balances.push({
        sourceId: sourceDoc.id,
        sourceName: sourceData.name,
        currency: sourceData.currency || "EUR",
        accountKind: sourceData.accountKind || "bank_account",
        openingBalance,
        transactionSum,
        balanceAtDate: openingBalance + transactionSum,
      });
    }

    return { balances, date };
  }
);
