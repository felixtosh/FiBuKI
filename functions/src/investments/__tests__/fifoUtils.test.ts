/**
 * Tests for FIFO cost basis calculation engine.
 *
 * Covers:
 * - normalizeTradeType: broker-specific string normalization
 * - detectAssetType: heuristic asset type detection
 * - calculateFifoForTicker: FIFO lot queue, cost basis, gain/loss,
 *   Altbestand (AT), Spekulationsfrist (DE), partial lot consumption
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  normalizeTradeType,
  detectAssetType,
  calculateFifoForTicker,
} from "../fifoUtils";
import { InvestmentTrade } from "../../types/investment-trade";

// ============================================================================
// Helper: create a minimal InvestmentTrade for FIFO tests
// ============================================================================

function makeTrade(overrides: Partial<InvestmentTrade> & {
  id: string;
  date: string; // ISO date string for convenience
  tradeType: InvestmentTrade["tradeType"];
  quantity: number;
  netAmount: number;
}): InvestmentTrade {
  const d = new Date(overrides.date);
  return {
    id: overrides.id,
    userId: "user-1",
    sourceId: "src-1",
    date: Timestamp.fromDate(d),
    tradeType: overrides.tradeType,
    assetType: overrides.assetType ?? "stock",
    ticker: overrides.ticker ?? "AAPL",
    isin: overrides.isin ?? null,
    assetName: overrides.assetName ?? "Apple Inc.",
    quantity: overrides.quantity,
    pricePerUnit: overrides.pricePerUnit ?? Math.abs(overrides.netAmount) / overrides.quantity,
    grossAmount: overrides.grossAmount ?? overrides.netAmount,
    fees: overrides.fees ?? 0,
    netAmount: overrides.netAmount,
    currency: overrides.currency ?? "EUR",
    exchangeRateToEur: overrides.exchangeRateToEur ?? null,
    netAmountEur: overrides.netAmountEur ?? null,
    dedupeHash: overrides.dedupeHash ?? `hash_${overrides.id}`,
    importJobId: overrides.importJobId ?? null,
    _original: overrides._original ?? { date: "", quantity: "", pricePerUnit: "", grossAmount: "", fees: "", rawRow: {} },
    fifoCalculated: false,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  } as InvestmentTrade;
}

// ============================================================================
// normalizeTradeType
// ============================================================================

describe("normalizeTradeType", () => {
  it("should recognize buy variations", () => {
    expect(normalizeTradeType("buy")).toBe("buy");
    expect(normalizeTradeType("Buy")).toBe("buy");
    expect(normalizeTradeType("Kauf")).toBe("buy");
    expect(normalizeTradeType("Market Buy")).toBe("buy");
    expect(normalizeTradeType("Open Position")).toBe("buy");
    expect(normalizeTradeType("LONG")).toBe("buy");
  });

  it("should recognize sell variations", () => {
    expect(normalizeTradeType("sell")).toBe("sell");
    expect(normalizeTradeType("Verkauf")).toBe("sell");
    expect(normalizeTradeType("Market Sell")).toBe("sell");
    expect(normalizeTradeType("Close Position")).toBe("sell");
    expect(normalizeTradeType("SHORT")).toBe("sell");
  });

  it("should recognize dividend variations", () => {
    expect(normalizeTradeType("dividend")).toBe("dividend");
    expect(normalizeTradeType("Dividende")).toBe("dividend");
    expect(normalizeTradeType("Distribution")).toBe("dividend");
  });

  it("should recognize interest/staking", () => {
    expect(normalizeTradeType("interest")).toBe("interest");
    expect(normalizeTradeType("Zinsen")).toBe("interest");
    expect(normalizeTradeType("Staking Reward")).toBe("interest");
  });

  it("should recognize fee variations", () => {
    expect(normalizeTradeType("fee")).toBe("fee");
    expect(normalizeTradeType("Gebühr")).toBe("fee");
    expect(normalizeTradeType("Rollover Fee")).toBe("fee");
    expect(normalizeTradeType("Overnight Fee")).toBe("fee");
    expect(normalizeTradeType("Spread")).toBe("fee");
  });

  it("should recognize transfer types", () => {
    expect(normalizeTradeType("transfer in")).toBe("buy");
    expect(normalizeTradeType("transfer_in")).toBe("buy");
    expect(normalizeTradeType("transfer out")).toBe("sell");
    expect(normalizeTradeType("transfer_out")).toBe("sell");
    expect(normalizeTradeType("deposit")).toBe("buy");
    expect(normalizeTradeType("withdrawal")).toBe("sell");
  });

  it("should default to buy for unknown types", () => {
    expect(normalizeTradeType("something_else")).toBe("buy");
    expect(normalizeTradeType("")).toBe("buy");
  });

  it("should be case-insensitive and trim whitespace", () => {
    expect(normalizeTradeType("  BUY  ")).toBe("buy");
    expect(normalizeTradeType("  Dividend  ")).toBe("dividend");
  });
});

// ============================================================================
// detectAssetType
// ============================================================================

describe("detectAssetType", () => {
  it("should detect crypto by ticker", () => {
    expect(detectAssetType("BTC")).toBe("crypto");
    expect(detectAssetType("ETH")).toBe("crypto");
    expect(detectAssetType("SOL")).toBe("crypto");
    expect(detectAssetType("DOGE")).toBe("crypto");
    expect(detectAssetType("ADA")).toBe("crypto");
  });

  it("should detect crypto by name", () => {
    expect(detectAssetType("XYZ", null, "Bitcoin Cash")).toBe("crypto");
    expect(detectAssetType("XYZ", null, "Ethereum Classic")).toBe("crypto");
  });

  it("should detect ETFs by name keywords", () => {
    expect(detectAssetType("VWCE", null, "Vanguard FTSE All-World UCITS ETF")).toBe("etf");
    expect(detectAssetType("SXR8", null, "iShares Core S&P 500")).toBe("etf");
    expect(detectAssetType("XDWD", null, "Xtrackers MSCI World")).toBe("etf");
    expect(detectAssetType("LYX", null, "Lyxor Euro Stoxx 50")).toBe("etf");
  });

  it("should detect ETFs by exchange-suffixed tickers", () => {
    expect(detectAssetType("VWCE.DE")).toBe("etf");
    expect(detectAssetType("IWDA.AS")).toBe("etf");
    expect(detectAssetType("VUSA.L")).toBe("etf");
  });

  it("should detect bonds by name", () => {
    expect(detectAssetType("XYZ", null, "US Treasury Bond 10Y")).toBe("bond");
    expect(detectAssetType("XYZ", null, "Deutsche Anleihe 5J")).toBe("bond");
  });

  it("should detect stock if ISIN present and no other match", () => {
    expect(detectAssetType("AAPL", "US0378331005", "Apple Inc.")).toBe("stock");
    expect(detectAssetType("MSFT", "US5949181045")).toBe("stock");
  });

  it("should return 'other' when nothing matches", () => {
    expect(detectAssetType("XYZ")).toBe("other");
    expect(detectAssetType("UNKNOWN", null, "Some random thing")).toBe("other");
  });

  it("should be case-insensitive on ticker", () => {
    expect(detectAssetType("btc")).toBe("crypto");
    expect(detectAssetType("eth")).toBe("crypto");
  });
});

// ============================================================================
// calculateFifoForTicker — basic scenarios
// ============================================================================

describe("calculateFifoForTicker", () => {
  describe("basic buy-then-sell", () => {
    it("should calculate gain on simple buy → sell", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-10", tradeType: "buy", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "s1", date: "2024-06-15", tradeType: "sell", quantity: 10, netAmount: 1500 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].tradeId).toBe("s1");
      expect(results[0].realizedGainEur).toBe(500); // 1500 - 1000
      expect(results[0].costBasisEur).toBe(1000);
      expect(results[0].lotAssignments).toHaveLength(1);
      expect(results[0].lotAssignments[0].buyTradeId).toBe("b1");
      expect(results[0].lotAssignments[0].quantity).toBe(10);
    });

    it("should calculate loss on simple buy → sell", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-10", tradeType: "buy", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "s1", date: "2024-06-15", tradeType: "sell", quantity: 10, netAmount: 800 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].realizedGainEur).toBe(-200); // 800 - 1000
    });
  });

  describe("multiple lots (FIFO order)", () => {
    it("should consume oldest lot first", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 5, netAmount: -500 }),  // €100/unit
        makeTrade({ id: "b2", date: "2024-03-01", tradeType: "buy", quantity: 5, netAmount: -750 }),  // €150/unit
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 5, netAmount: 600 }),   // sells 5 @ €120
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      // Should use first lot (€100/unit) → cost = 500, proceeds = 600, gain = 100
      expect(results[0].costBasisEur).toBe(500);
      expect(results[0].realizedGainEur).toBe(100);
      expect(results[0].lotAssignments[0].buyTradeId).toBe("b1");
    });

    it("should split across lots when selling more than first lot", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 3, netAmount: -300 }),  // €100/unit
        makeTrade({ id: "b2", date: "2024-02-01", tradeType: "buy", quantity: 7, netAmount: -1400 }), // €200/unit
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 5, netAmount: 750 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].lotAssignments).toHaveLength(2);
      // 3 units from b1 (€100/u = 300) + 2 units from b2 (€200/u = 400) = 700 cost
      expect(results[0].lotAssignments[0].buyTradeId).toBe("b1");
      expect(results[0].lotAssignments[0].quantity).toBe(3);
      expect(results[0].lotAssignments[1].buyTradeId).toBe("b2");
      expect(results[0].lotAssignments[1].quantity).toBe(2);
      expect(results[0].costBasisEur).toBe(700);
      expect(results[0].realizedGainEur).toBe(50); // 750 - 700
    });
  });

  describe("multiple sells", () => {
    it("should track lot queue correctly across multiple sells", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000 }), // €100/u
        makeTrade({ id: "s1", date: "2024-03-01", tradeType: "sell", quantity: 4, netAmount: 600 }),
        makeTrade({ id: "s2", date: "2024-06-01", tradeType: "sell", quantity: 6, netAmount: 1200 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(2);

      // First sell: 4 units, cost = 400, proceeds = 600 → gain = 200
      expect(results[0].tradeId).toBe("s1");
      expect(results[0].costBasisEur).toBe(400);
      expect(results[0].realizedGainEur).toBe(200);

      // Second sell: 6 remaining units, cost = 600, proceeds = 1200 → gain = 600
      expect(results[1].tradeId).toBe("s2");
      expect(results[1].costBasisEur).toBe(600);
      expect(results[1].realizedGainEur).toBe(600);
    });
  });

  describe("dividends and fees don't affect FIFO", () => {
    it("should ignore dividend trades in lot queue", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "d1", date: "2024-03-01", tradeType: "dividend", quantity: 0, netAmount: 50 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1200 }),
      ];

      const results = calculateFifoForTicker(trades);
      // Only one result for the sell (dividend is ignored)
      expect(results).toHaveLength(1);
      expect(results[0].costBasisEur).toBe(1000);
      expect(results[0].realizedGainEur).toBe(200);
    });

    it("should ignore fee trades in lot queue", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "f1", date: "2024-02-01", tradeType: "fee", quantity: 0, netAmount: -5 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1200 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].costBasisEur).toBe(1000);
    });
  });

  describe("transfer_in behaves like buy", () => {
    it("should add transfer_in to lot queue", () => {
      const trades = [
        makeTrade({ id: "t1", date: "2024-01-01", tradeType: "transfer_in", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1500 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].costBasisEur).toBe(1000);
      expect(results[0].realizedGainEur).toBe(500);
    });
  });

  describe("netAmountEur takes precedence", () => {
    it("should use netAmountEur for cost basis when available", () => {
      const trades = [
        makeTrade({
          id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10,
          netAmount: -1100, // USD
          netAmountEur: -1000, // EUR
          currency: "USD",
        }),
        makeTrade({
          id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10,
          netAmount: 1650, // USD
          netAmountEur: 1500, // EUR
          currency: "USD",
        }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      expect(results[0].costBasisEur).toBe(1000);
      expect(results[0].realizedGainEur).toBe(500);
    });
  });

  // ============================================================================
  // Country-specific flags
  // ============================================================================

  describe("Austrian Altbestand flag", () => {
    it("should mark as Altbestand when buy date is before 2021-03-01", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2020-06-15", tradeType: "buy", quantity: 1, netAmount: -5000, assetType: "crypto" }),
        makeTrade({ id: "s1", date: "2024-06-15", tradeType: "sell", quantity: 1, netAmount: 50000, assetType: "crypto" }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results[0].isAltbestand).toBe(true);
    });

    it("should NOT mark as Altbestand when buy date is after 2021-03-01", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2021-04-01", tradeType: "buy", quantity: 1, netAmount: -5000 }),
        makeTrade({ id: "s1", date: "2024-06-15", tradeType: "sell", quantity: 1, netAmount: 50000 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results[0].isAltbestand).toBe(false);
    });

    it("should NOT mark as Altbestand when mixed lots (some before, some after cutoff)", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2020-01-01", tradeType: "buy", quantity: 5, netAmount: -500 }),
        makeTrade({ id: "b2", date: "2022-01-01", tradeType: "buy", quantity: 5, netAmount: -1000 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 8, netAmount: 2000 }),
      ];

      const results = calculateFifoForTicker(trades);
      // Uses lots from b1 (pre-cutoff) AND b2 (post-cutoff) → not all Altbestand
      expect(results[0].isAltbestand).toBe(false);
    });
  });

  describe("German Spekulationsfrist (holding period > 1yr)", () => {
    it("should mark as holding period exempt when held > 365 days", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2023-01-01", tradeType: "buy", quantity: 1, netAmount: -100, assetType: "crypto" }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 1, netAmount: 200, assetType: "crypto" }),
      ];

      const results = calculateFifoForTicker(trades);
      // 517 days held → exempt
      expect(results[0].isHoldingPeriodExempt).toBe(true);
    });

    it("should NOT mark as exempt when held < 365 days", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-03-01", tradeType: "buy", quantity: 1, netAmount: -100 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 1, netAmount: 200 }),
      ];

      const results = calculateFifoForTicker(trades);
      // 92 days → not exempt
      expect(results[0].isHoldingPeriodExempt).toBe(false);
    });

    it("should NOT mark as exempt when mixed lots (some < 1yr, some > 1yr)", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2022-01-01", tradeType: "buy", quantity: 5, netAmount: -500 }),
        makeTrade({ id: "b2", date: "2024-05-01", tradeType: "buy", quantity: 5, netAmount: -500 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 8, netAmount: 1200 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results[0].isHoldingPeriodExempt).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle no sell trades", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(0);
    });

    it("should handle empty trade array", () => {
      const results = calculateFifoForTicker([]);
      expect(results).toHaveLength(0);
    });

    it("should handle sell with no available lots (oversold)", () => {
      const trades = [
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1000 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results).toHaveLength(1);
      // No cost basis available → full proceeds as gain
      expect(results[0].costBasisEur).toBe(0);
      expect(results[0].realizedGainEur).toBe(1000);
      expect(results[0].lotAssignments).toHaveLength(0);
    });

    it("should handle zero-gain trade", () => {
      const trades = [
        makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000 }),
        makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1000 }),
      ];

      const results = calculateFifoForTicker(trades);
      expect(results[0].realizedGainEur).toBe(0);
    });
  });
});
