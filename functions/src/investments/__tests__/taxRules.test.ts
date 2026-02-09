/**
 * Tests for DACH tax rule calculations.
 *
 * Covers:
 * - Austria: 27.5% KESt, loss offset within year, Altbestand exclusion
 * - Germany: Abgeltungssteuer, separate stock/crypto pools, Sparerpauschbetrag,
 *   holding period exemption for crypto
 * - Switzerland: year-end holdings calculation, buy/sell netting
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { calculateAustriaTax } from "../taxRules/austria";
import { calculateGermanyTax, ABGELTUNGSSTEUER_RATE, SPARERPAUSCHBETRAG } from "../taxRules/germany";
import { calculateYearEndHoldings } from "../taxRules/switzerland";
import { AssetTypeSummary } from "../../types/capital-gains-summary";
import { InvestmentTrade } from "../../types/investment-trade";

// ============================================================================
// Helpers
// ============================================================================

function makeSummary(overrides: Partial<AssetTypeSummary> & { assetType: AssetTypeSummary["assetType"] }): AssetTypeSummary {
  return {
    realizedGainEur: 0,
    realizedLossEur: 0,
    netGainEur: 0,
    dividendsEur: 0,
    feesEur: 0,
    tradeCount: 0,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<InvestmentTrade> & {
  id: string;
  date: string;
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
    isin: null,
    assetName: overrides.assetName ?? "Test",
    quantity: overrides.quantity,
    pricePerUnit: 0,
    grossAmount: overrides.netAmount,
    fees: 0,
    netAmount: overrides.netAmount,
    currency: "EUR",
    exchangeRateToEur: null,
    netAmountEur: overrides.netAmountEur ?? null,
    dedupeHash: `hash_${overrides.id}`,
    importJobId: null,
    _original: { date: "", quantity: "", pricePerUnit: "", grossAmount: "", fees: "", rawRow: {} },
    fifoCalculated: false,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  } as InvestmentTrade;
}

// ============================================================================
// Austria: 27.5% KESt
// ============================================================================

describe("calculateAustriaTax", () => {
  it("should calculate 27.5% KESt on net gains", () => {
    const summaries = [
      makeSummary({ assetType: "stock", realizedGainEur: 10000, realizedLossEur: 0, netGainEur: 10000 }),
    ];
    const result = calculateAustriaTax(summaries);
    expect(result.kestLiabilityEur).toBe(Math.round(10000 * 0.275));
  });

  it("should offset losses against gains within same year", () => {
    const summaries = [
      makeSummary({ assetType: "stock", realizedGainEur: 10000, realizedLossEur: 3000, netGainEur: 7000 }),
    ];
    const result = calculateAustriaTax(summaries);
    expect(result.kestLiabilityEur).toBe(Math.round(7000 * 0.275));
  });

  it("should offset cross-asset-type (stocks vs crypto in AT)", () => {
    const summaries = [
      makeSummary({ assetType: "stock", realizedGainEur: 5000, netGainEur: 5000 }),
      makeSummary({ assetType: "crypto", realizedGainEur: 0, realizedLossEur: 2000, netGainEur: -2000 }),
    ];
    const result = calculateAustriaTax(summaries);
    // Net gain = 5000 - 2000 = 3000
    expect(result.kestLiabilityEur).toBe(Math.round(3000 * 0.275));
  });

  it("should include dividends in taxable amount", () => {
    const summaries = [
      makeSummary({ assetType: "stock", netGainEur: 0, dividendsEur: 1000 }),
    ];
    const result = calculateAustriaTax(summaries);
    expect(result.kestLiabilityEur).toBe(Math.round(1000 * 0.275));
  });

  it("should return 0 when net result is a loss", () => {
    const summaries = [
      makeSummary({ assetType: "stock", realizedLossEur: 5000, netGainEur: -5000 }),
    ];
    const result = calculateAustriaTax(summaries);
    expect(result.kestLiabilityEur).toBe(0);
  });

  it("should handle empty summaries", () => {
    const result = calculateAustriaTax([]);
    expect(result.kestLiabilityEur).toBe(0);
  });
});

// ============================================================================
// Germany: Abgeltungssteuer
// ============================================================================

describe("calculateGermanyTax", () => {
  it("should export correct Abgeltungssteuer rate", () => {
    expect(ABGELTUNGSSTEUER_RATE).toBeCloseTo(0.26375);
  });

  it("should export correct Sparerpauschbetrag", () => {
    expect(SPARERPAUSCHBETRAG).toBe(100000); // €1,000 in cents
  });

  it("should separate stock and crypto pools", () => {
    const summaries = [
      makeSummary({ assetType: "stock", realizedGainEur: 5000, realizedLossEur: 1000, dividendsEur: 500 }),
      makeSummary({ assetType: "crypto", realizedGainEur: 3000, realizedLossEur: 800, dividendsEur: 200 }),
    ];

    const result = calculateGermanyTax(summaries, 0);

    // Stocks: gains (5000) + dividends (500) = 5500
    expect(result.deStockGainsEur).toBe(5500);
    expect(result.deStockLossesEur).toBe(1000);

    // Crypto: gains (3000) + dividends (200) = 3200
    expect(result.deCryptoGainsEur).toBe(3200);
    expect(result.deCryptoLossesEur).toBe(800);
  });

  it("should include ETF and bond in stock pool", () => {
    const summaries = [
      makeSummary({ assetType: "etf", realizedGainEur: 3000, dividendsEur: 200 }),
      makeSummary({ assetType: "bond", realizedGainEur: 1000, dividendsEur: 100 }),
    ];

    const result = calculateGermanyTax(summaries, 0);
    expect(result.deStockGainsEur).toBe(4300); // 3200 + 1100
  });

  it("should report crypto exempt gains", () => {
    const summaries = [
      makeSummary({ assetType: "crypto", realizedGainEur: 5000 }),
    ];

    const result = calculateGermanyTax(summaries, 2000);
    expect(result.deCryptoExemptGainsEur).toBe(2000);
  });

  it("should handle zero gains", () => {
    const result = calculateGermanyTax([], 0);
    expect(result.deStockGainsEur).toBe(0);
    expect(result.deStockLossesEur).toBe(0);
    expect(result.deCryptoGainsEur).toBe(0);
    expect(result.deCryptoLossesEur).toBe(0);
    expect(result.deCryptoExemptGainsEur).toBe(0);
  });
});

// ============================================================================
// Switzerland: Year-end holdings
// ============================================================================

describe("calculateYearEndHoldings", () => {
  it("should aggregate buys into holdings", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2024-03-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "b2", date: "2024-06-01", tradeType: "buy", quantity: 5, netAmount: -600, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].ticker).toBe("AAPL");
    expect(holdings[0].quantity).toBe(15);
    expect(holdings[0].marketValueEur).toBe(1600); // 1000 + 600
  });

  it("should subtract sells from holdings", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 4, netAmount: 600, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(6);
  });

  it("should exclude fully sold positions", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "s1", date: "2024-06-01", tradeType: "sell", quantity: 10, netAmount: 1200, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings).toHaveLength(0);
  });

  it("should handle multiple tickers", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL", assetName: "Apple" }),
      makeTrade({ id: "b2", date: "2024-01-01", tradeType: "buy", quantity: 5, netAmount: -2500, ticker: "MSFT", assetName: "Microsoft" }),
      makeTrade({ id: "b3", date: "2024-01-01", tradeType: "buy", quantity: 1, netAmount: -50000, ticker: "BTC", assetName: "Bitcoin", assetType: "crypto" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings).toHaveLength(3);
    const tickers = holdings.map((h) => h.ticker);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("MSFT");
    expect(tickers).toContain("BTC");
  });

  it("should only include trades up to year end", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2024-06-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "b2", date: "2025-03-01", tradeType: "buy", quantity: 5, netAmount: -500, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(10); // Only 2024 trade
  });

  it("should include prior years' trades in year-end position", () => {
    const trades = [
      makeTrade({ id: "b1", date: "2023-01-01", tradeType: "buy", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "b2", date: "2024-06-01", tradeType: "buy", quantity: 5, netAmount: -600, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings[0].quantity).toBe(15);
  });

  it("should handle transfer_in as buys and transfer_out as sells", () => {
    const trades = [
      makeTrade({ id: "t1", date: "2024-01-01", tradeType: "transfer_in", quantity: 10, netAmount: -1000, ticker: "AAPL" }),
      makeTrade({ id: "t2", date: "2024-06-01", tradeType: "transfer_out", quantity: 3, netAmount: 0, ticker: "AAPL" }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings[0].quantity).toBe(7);
  });

  it("should use netAmountEur when available", () => {
    const trades = [
      makeTrade({
        id: "b1", date: "2024-01-01", tradeType: "buy", quantity: 10,
        netAmount: -1100, netAmountEur: -1000, ticker: "AAPL", currency: "USD",
      }),
    ];

    const holdings = calculateYearEndHoldings(trades, 2024);
    expect(holdings[0].marketValueEur).toBe(1000);
  });

  it("should return empty array for no trades", () => {
    const holdings = calculateYearEndHoldings([], 2024);
    expect(holdings).toHaveLength(0);
  });
});
