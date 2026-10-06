/**
 * Swiss capital gains tax rules.
 *
 * - No capital gains tax for private investors
 * - Wealth tax on year-end holdings (cantonal rates vary)
 * - Need to report year-end portfolio value
 */

import { InvestmentTrade } from "../../types/investment-trade";
import { YearEndHolding } from "../../types/capital-gains-summary";

/**
 * Calculate year-end holdings from trades.
 * Sums up all buys minus sells per ticker to get remaining positions.
 */
export function calculateYearEndHoldings(
  trades: InvestmentTrade[],
  year: number
): YearEndHolding[] {
  const nextYear = new Date(Date.UTC(year + 1, 0, 1));

  // Only consider trades up to year end
  const relevantTrades = trades.filter(
    (t) => t.date.toDate() < nextYear
  );

  // Aggregate holdings per ticker
  const holdings = new Map<string, {
    ticker: string;
    assetName: string;
    assetType: InvestmentTrade["assetType"];
    quantity: number;
    totalCostEur: number;
  }>();

  for (const trade of relevantTrades) {
    const key = trade.ticker.toUpperCase();
    if (!holdings.has(key)) {
      holdings.set(key, {
        ticker: trade.ticker,
        assetName: trade.assetName,
        assetType: trade.assetType,
        quantity: 0,
        totalCostEur: 0,
      });
    }

    const h = holdings.get(key)!;
    const amountEur = trade.netAmountEur ?? trade.netAmount;

    if (trade.tradeType === "buy" || trade.tradeType === "transfer_in") {
      h.quantity += trade.quantity;
      h.totalCostEur += Math.abs(amountEur);
    } else if (trade.tradeType === "sell" || trade.tradeType === "transfer_out") {
      h.quantity -= trade.quantity;
    }
  }

  // Return only positions with remaining quantity
  return Array.from(holdings.values())
    .filter((h) => h.quantity > 0.0001)
    .map((h) => ({
      ticker: h.ticker,
      assetName: h.assetName,
      assetType: h.assetType,
      quantity: h.quantity,
      // Use cost basis as approximate market value (user can override)
      marketValueEur: Math.round(h.totalCostEur),
    }));
}
