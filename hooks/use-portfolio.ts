"use client";

import { toDateSafe } from "@/lib/utils";
import { useMemo } from "react";
import { InvestmentTrade } from "@/types/investment-trade";

export interface PortfolioHolding {
  ticker: string;
  assetName: string;
  assetType: InvestmentTrade["assetType"];
  quantity: number;
  /** Average cost per unit in cents */
  avgCostPerUnit: number;
  /** Total cost basis in cents */
  totalCost: number;
  /** Total realized gain/loss for closed positions */
  realizedGainEur: number;
  currency: string;
}

/**
 * Compute current portfolio holdings from trades (client-side aggregation).
 */
export function usePortfolio(trades: InvestmentTrade[]) {
  const holdings = useMemo(() => {
    const holdingsMap = new Map<string, PortfolioHolding>();

    // Process trades in date order (ascending)
    const sorted = [...trades].sort((a, b) => {
      const da = toDateSafe(a.date) ?? new Date(0);
      const db = toDateSafe(b.date) ?? new Date(0);
      return da.getTime() - db.getTime();
    });

    for (const trade of sorted) {
      const key = trade.ticker.toUpperCase();

      if (!holdingsMap.has(key)) {
        holdingsMap.set(key, {
          ticker: trade.ticker,
          assetName: trade.assetName,
          assetType: trade.assetType,
          quantity: 0,
          avgCostPerUnit: 0,
          totalCost: 0,
          realizedGainEur: 0,
          currency: trade.currency,
        });
      }

      const h = holdingsMap.get(key)!;

      if (trade.tradeType === "buy" || trade.tradeType === "transfer_in") {
        const cost = Math.abs(trade.netAmountEur ?? trade.netAmount);
        h.totalCost += cost;
        h.quantity += trade.quantity;
        h.avgCostPerUnit = h.quantity > 0 ? Math.round(h.totalCost / h.quantity) : 0;
      } else if (trade.tradeType === "sell" || trade.tradeType === "transfer_out") {
        // Reduce position
        const soldRatio = Math.min(trade.quantity / h.quantity, 1);
        h.totalCost -= Math.round(h.totalCost * soldRatio);
        h.quantity -= trade.quantity;
        h.avgCostPerUnit = h.quantity > 0 ? Math.round(h.totalCost / h.quantity) : 0;
        h.realizedGainEur += trade.realizedGainEur ?? 0;
      }
    }

    // Return only positions with remaining quantity
    return Array.from(holdingsMap.values())
      .filter((h) => h.quantity > 0.0001)
      .sort((a, b) => b.totalCost - a.totalCost);
  }, [trades]);

  return { holdings };
}
