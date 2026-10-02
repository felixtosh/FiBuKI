/**
 * Bulk create investment trades from a broker CSV import
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { computeDedupeHash } from "../imports/dedupe";

interface TradeData {
  sourceId: string;
  date: string; // ISO string
  tradeType: string;
  assetType: string;
  ticker: string;
  isin?: string | null;
  assetName: string;
  quantity: number;
  pricePerUnit: number;
  grossAmount: number;
  fees: number;
  netAmount: number;
  currency: string;
  exchangeRateToEur?: number | null;
  netAmountEur?: number | null;
  /** Ignored: the hash is computed here (imports/dedupe.ts), so no client can disagree with it. */
  dedupeHash?: string;
  importJobId: string;
  csvRowIndex?: number;
  _original: {
    date: string;
    quantity: string;
    pricePerUnit: string;
    grossAmount: string;
    fees: string;
    rawRow: Record<string, string>;
  };
}

interface BulkCreateTradesRequest {
  trades: TradeData[];
  sourceId: string;
}

interface BulkCreateTradesResponse {
  success: boolean;
  tradeIds: string[];
  count: number;
}

const BATCH_SIZE = 500;

export const bulkCreateTradesCallable = createCallable<
  BulkCreateTradesRequest,
  BulkCreateTradesResponse
>(
  {
    name: "bulkCreateTrades",
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (ctx, request) => {
    const { trades, sourceId } = request;

    if (!trades || !Array.isArray(trades)) {
      throw new HttpsError("invalid-argument", "trades array is required");
    }

    if (!sourceId) {
      throw new HttpsError("invalid-argument", "sourceId is required");
    }

    if (trades.length === 0) {
      return { success: true, tradeIds: [], count: 0 };
    }

    if (trades.length > 5000) {
      throw new HttpsError(
        "invalid-argument",
        "Cannot import more than 5000 trades at once"
      );
    }

    // Verify source ownership and type
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();

    if (!sourceSnap.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    const sourceData = sourceSnap.data()!;
    if (sourceData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Source access denied");
    }

    if (sourceData.accountKind !== "depot") {
      throw new HttpsError("invalid-argument", "Source is not a depot account");
    }

    // Check investments addon access
    const subSnap = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    if (subSnap.exists) {
      const sub = subSnap.data()!;
      const isAdmin = ctx.request.auth?.token?.admin === true;
      if (!isAdmin && !sub.addons?.investments?.active) {
        throw new HttpsError(
          "permission-denied",
          "Investments addon required. Activate it in Settings > Billing."
        );
      }
    }

    const now = Timestamp.now();
    const tradeIds: string[] = [];

    // Process in batches
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = ctx.db.batch();
      const chunk = trades.slice(i, i + BATCH_SIZE);

      for (const tradeData of chunk) {
        const docRef = ctx.db.collection("investmentTrades").doc();
        tradeIds.push(docRef.id);

        const date = new Date(tradeData.date);
        if (isNaN(date.getTime())) {
          throw new HttpsError(
            "invalid-argument",
            `Invalid date for trade: ${tradeData.date}`
          );
        }

        const tradeDoc: Record<string, unknown> = {
          userId: ctx.userId,
          sourceId: tradeData.sourceId,
          date: Timestamp.fromDate(date),
          tradeType: tradeData.tradeType,
          assetType: tradeData.assetType,
          ticker: tradeData.ticker,
          isin: tradeData.isin ?? null,
          assetName: tradeData.assetName,
          quantity: tradeData.quantity,
          pricePerUnit: tradeData.pricePerUnit,
          grossAmount: tradeData.grossAmount,
          fees: tradeData.fees,
          netAmount: tradeData.netAmount,
          currency: tradeData.currency,
          exchangeRateToEur: tradeData.exchangeRateToEur ?? null,
          netAmountEur: tradeData.netAmountEur ?? null,
          dedupeHash: computeDedupeHash({
            date,
            amount: tradeData.grossAmount,
            sourceIdentifier: tradeData.sourceId,
            reference: `${tradeData.ticker}_${tradeData.tradeType}_${tradeData.quantity}`,
          }),
          importJobId: tradeData.importJobId,
          csvRowIndex: tradeData.csvRowIndex,
          _original: tradeData._original,
          // FIFO fields — not yet calculated
          realizedGainEur: null,
          costBasisEur: null,
          fifoCalculated: false,
          createdAt: now,
          updatedAt: now,
        };

        batch.set(docRef, tradeDoc);
      }

      await batch.commit();
    }

    console.log(`[bulkCreateTrades] Created ${tradeIds.length} trades`, {
      userId: ctx.userId,
      sourceId,
    });

    return {
      success: true,
      tradeIds,
      count: tradeIds.length,
    };
  }
);
