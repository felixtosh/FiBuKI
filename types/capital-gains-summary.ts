import type { Timestamp } from "firebase/firestore";
import { TaxCountryCode } from "./user-data";
import { AssetType } from "./investment-trade";

/**
 * Per-asset-type breakdown within a capital gains summary.
 */
export interface AssetTypeSummary {
  assetType: AssetType;
  realizedGainEur: number;
  realizedLossEur: number;
  netGainEur: number;
  dividendsEur: number;
  feesEur: number;
  tradeCount: number;
}

/**
 * Year-end holding for Swiss wealth tax reporting.
 */
export interface YearEndHolding {
  ticker: string;
  assetName: string;
  assetType: AssetType;
  quantity: number;
  /** Estimated market value in EUR cents at year end */
  marketValueEur: number;
}

/**
 * Annual capital gains summary for a user.
 * Stored in `capitalGainsSummaries` collection, doc ID: `{userId}_{year}`.
 */
export interface CapitalGainsSummary {
  id: string;
  userId: string;
  year: number;
  country: TaxCountryCode;

  /** Breakdown by asset type */
  byAssetType: AssetTypeSummary[];

  /** Totals across all asset types */
  totalRealizedGainEur: number;
  totalRealizedLossEur: number;
  totalNetGainEur: number;
  totalDividendsEur: number;
  totalFeesEur: number;

  // === Austria-specific ===
  /** KESt liability at 27.5% */
  kestLiabilityEur?: number;

  // === Germany-specific ===
  /** Stock gains (separate loss offset pool) */
  deStockGainsEur?: number;
  deStockLossesEur?: number;
  /** Crypto gains/losses (separate from stocks) */
  deCryptoGainsEur?: number;
  deCryptoLossesEur?: number;
  /** Crypto gains exempt due to >1yr holding period */
  deCryptoExemptGainsEur?: number;

  // === Switzerland-specific ===
  /** Year-end holdings for wealth tax */
  chYearEndHoldings?: YearEndHolding[];

  tradeCount: number;
  calculatedAt: Timestamp;
}
