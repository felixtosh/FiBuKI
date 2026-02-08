/**
 * Compute account balance at a specific date.
 * Balance = openingBalance + sum(transactions from openingBalanceDate to targetDate)
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface GetBalanceAtDateRequest {
  sourceId: string;
  date: string; // ISO string, e.g. "2025-12-31"
}

interface GetBalanceAtDateResponse {
  balance: number; // in cents
  openingBalance: number;
  transactionSum: number;
  transactionCount: number;
  date: string;
  sourceId: string;
  sourceName: string;
  currency: string;
}

export const getBalanceAtDateCallable = createCallable<
  GetBalanceAtDateRequest,
  GetBalanceAtDateResponse
>(
  { name: "getBalanceAtDate" },
  async (ctx, request) => {
    const { sourceId, date } = request;

    if (!sourceId) {
      throw new HttpsError("invalid-argument", "sourceId is required");
    }
    if (!date) {
      throw new HttpsError("invalid-argument", "date is required");
    }

    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date format");
    }

    // Set to end of day
    targetDate.setHours(23, 59, 59, 999);

    // Verify ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();

    if (!sourceSnap.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    const sourceData = sourceSnap.data()!;
    if (sourceData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const openingBalance = sourceData.openingBalance ?? 0;
    const openingBalanceDate = sourceData.openingBalanceDate?.toDate();

    // Query transactions up to targetDate
    let query = ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
      .where("sourceId", "==", sourceId)
      .where("date", "<=", Timestamp.fromDate(targetDate));

    // If we have an opening balance date, only sum transactions from that date onward
    if (openingBalanceDate) {
      query = query.where("date", ">=", Timestamp.fromDate(openingBalanceDate));
    }

    const snapshot = await query.get();

    let transactionSum = 0;
    for (const doc of snapshot.docs) {
      transactionSum += doc.data().amount ?? 0;
    }

    return {
      balance: openingBalance + transactionSum,
      openingBalance,
      transactionSum,
      transactionCount: snapshot.size,
      date,
      sourceId,
      sourceName: sourceData.name,
      currency: sourceData.currency || "EUR",
    };
  }
);
