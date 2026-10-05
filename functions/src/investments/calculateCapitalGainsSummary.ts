/**
 * Calculate annual capital gains summary for a user.
 * Aggregates FIFO results, applies tax rules based on user's country.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { InvestmentTrade, AssetType } from "../types/investment-trade";
import { AssetTypeSummary, TaxCountryCode } from "../types/capital-gains-summary";
import { calculateAustriaTax } from "./taxRules/austria";
import { calculateGermanyTax } from "./taxRules/germany";
import { calculateYearEndHoldings } from "./taxRules/switzerland";

interface CalculateCapitalGainsSummaryRequest {
  year: number;
}

interface CalculateCapitalGainsSummaryResponse {
  success: boolean;
  summaryId: string;
}

export const calculateCapitalGainsSummaryCallable = createCallable<
  CalculateCapitalGainsSummaryRequest,
  CalculateCapitalGainsSummaryResponse
>(
  {
    name: "calculateCapitalGainsSummary",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (ctx, request) => {
    const { year } = request;

    if (!year || year < 2000 || year > 2100) {
      throw new HttpsError("invalid-argument", "Valid year is required");
    }

    // Get user's tax country
    const userDataSnap = await ctx.db
      .collection("userData")
      .doc(ctx.userId)
      .get();

    const country: TaxCountryCode = (userDataSnap.data()?.country as TaxCountryCode) || "AT";

    // Fetch all trades for this user in the given year
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

    const tradesSnap = await ctx.db
      .collection("investmentTrades")
      .where("userId", "==", ctx.userId)
      .where("date", ">=", Timestamp.fromDate(yearStart))
      .where("date", "<", Timestamp.fromDate(yearEnd))
      .orderBy("date", "asc")
      .get();

    const trades: InvestmentTrade[] = tradesSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as InvestmentTrade[];

    // Aggregate by asset type
    const assetTypeMap = new Map<AssetType, AssetTypeSummary>();

    for (const trade of trades) {
      if (!assetTypeMap.has(trade.assetType)) {
        assetTypeMap.set(trade.assetType, {
          assetType: trade.assetType,
          realizedGainEur: 0,
          realizedLossEur: 0,
          netGainEur: 0,
          dividendsEur: 0,
          feesEur: 0,
          tradeCount: 0,
        });
      }

      const summary = assetTypeMap.get(trade.assetType)!;
      summary.tradeCount++;

      if (trade.tradeType === "sell") {
        const gain = trade.realizedGainEur ?? 0;

        // For AT: skip Altbestand gains (tax-free)
        if (country === "AT" && trade.isAltbestand) {
          continue;
        }
        // For DE: skip holding-period-exempt crypto gains (tax-free)
        if (country === "DE" && trade.assetType === "crypto" && trade.isHoldingPeriodExempt) {
          continue;
        }

        if (gain >= 0) {
          summary.realizedGainEur += gain;
        } else {
          summary.realizedLossEur += Math.abs(gain);
        }
        summary.netGainEur += gain;
      } else if (trade.tradeType === "dividend" || trade.tradeType === "interest") {
        const amount = trade.netAmountEur ?? trade.netAmount;
        summary.dividendsEur += Math.abs(amount);
      } else if (trade.tradeType === "fee") {
        const amount = trade.netAmountEur ?? trade.netAmount;
        summary.feesEur += Math.abs(amount);
      }
    }

    const byAssetType = Array.from(assetTypeMap.values());

    // Calculate totals
    let totalRealizedGainEur = 0;
    let totalRealizedLossEur = 0;
    let totalNetGainEur = 0;
    let totalDividendsEur = 0;
    let totalFeesEur = 0;

    for (const s of byAssetType) {
      totalRealizedGainEur += s.realizedGainEur;
      totalRealizedLossEur += s.realizedLossEur;
      totalNetGainEur += s.netGainEur;
      totalDividendsEur += s.dividendsEur;
      totalFeesEur += s.feesEur;
    }

    // Build summary document
    const summaryId = `${ctx.userId}_${year}`;
    const summaryDoc: Record<string, unknown> = {
      userId: ctx.userId,
      year,
      country,
      byAssetType,
      totalRealizedGainEur,
      totalRealizedLossEur,
      totalNetGainEur,
      totalDividendsEur,
      totalFeesEur,
      tradeCount: trades.length,
      calculatedAt: Timestamp.now(),
    };

    // Apply country-specific tax rules
    if (country === "AT") {
      const atResult = calculateAustriaTax(byAssetType);
      summaryDoc.kestLiabilityEur = atResult.kestLiabilityEur;
    } else if (country === "DE") {
      // Calculate exempt crypto gains
      let cryptoExemptGains = 0;
      for (const trade of trades) {
        if (trade.assetType === "crypto" && trade.tradeType === "sell" && trade.isHoldingPeriodExempt) {
          cryptoExemptGains += Math.max(0, trade.realizedGainEur ?? 0);
        }
      }

      const deResult = calculateGermanyTax(byAssetType, cryptoExemptGains);
      summaryDoc.deStockGainsEur = deResult.deStockGainsEur;
      summaryDoc.deStockLossesEur = deResult.deStockLossesEur;
      summaryDoc.deCryptoGainsEur = deResult.deCryptoGainsEur;
      summaryDoc.deCryptoLossesEur = deResult.deCryptoLossesEur;
      summaryDoc.deCryptoExemptGainsEur = deResult.deCryptoExemptGainsEur;
    } else if (country === "CH") {
      // For Switzerland, also fetch ALL trades (not just this year) for year-end holdings
      const allTradesSnap = await ctx.db
        .collection("investmentTrades")
        .where("userId", "==", ctx.userId)
        .where("date", "<", Timestamp.fromDate(yearEnd))
        .orderBy("date", "asc")
        .get();

      const allTrades = allTradesSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as InvestmentTrade[];

      summaryDoc.chYearEndHoldings = calculateYearEndHoldings(allTrades, year);
    }

    // Upsert summary document
    await ctx.db
      .collection("capitalGainsSummaries")
      .doc(summaryId)
      .set(summaryDoc, { merge: true });

    console.log(`[calculateCapitalGainsSummary] Generated summary for ${year}`, {
      userId: ctx.userId,
      country,
      tradeCount: trades.length,
      totalNetGainEur,
    });

    return {
      success: true,
      summaryId,
    };
  }
);
