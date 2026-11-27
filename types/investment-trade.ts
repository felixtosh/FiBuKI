import type { Timestamp } from "firebase/firestore";

/**
 * Type of investment trade/transaction
 */
export type TradeType =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "fee"
  | "transfer_in"
  | "transfer_out";

/**
 * Type of financial asset
 */
export type AssetType = "stock" | "etf" | "crypto" | "bond" | "other";

/**
 * A FIFO lot assignment — maps a portion of a sell to a specific buy lot.
 */
export interface FifoLotAssignment {
  /** The buy trade that this lot came from */
  buyTradeId: string;
  /** Quantity consumed from this lot */
  quantity: number;
  /** Cost per unit in EUR at time of buy */
  costPerUnitEur: number;
  /** Date of the original buy */
  buyDate: Timestamp;
}

/**
 * An investment trade imported from a broker CSV.
 * Stored in `investmentTrades` Firestore collection.
 */
export interface InvestmentTrade {
  id: string;
  userId: string;
  sourceId: string;

  /** Trade execution date */
  date: Timestamp;
  /** Type of trade */
  tradeType: TradeType;
  /** Asset class */
  assetType: AssetType;
  /** Ticker symbol, e.g. "AAPL", "BTC" */
  ticker: string;
  /** ISIN for stocks/ETFs (optional) */
  isin?: string | null;
  /** Human-readable asset name, e.g. "Apple Inc." */
  assetName: string;

  // === Amounts (in cents / smallest currency unit) ===

  /** Quantity traded (can be fractional for crypto) */
  quantity: number;
  /** Price per unit in cents */
  pricePerUnit: number;
  /** Gross amount = qty * price (in cents) */
  grossAmount: number;
  /** Fees/commissions in cents */
  fees: number;
  /** Net amount after fees in cents */
  netAmount: number;
  /** Currency code */
  currency: string;
  /** Exchange rate to EUR (if not EUR) */
  exchangeRateToEur?: number | null;
  /** Net amount converted to EUR cents */
  netAmountEur?: number | null;

  // === Import metadata ===

  /** Original values before parsing */
  _original: {
    date: string;
    quantity: string;
    pricePerUnit: string;
    grossAmount: string;
    fees: string;
    rawRow: Record<string, string>;
  };
  /** SHA256 hash for deduplication */
  dedupeHash: string;
  /** Import job ID */
  importJobId: string | null;
  /** Row index in original CSV */
  csvRowIndex?: number;

  // === FIFO computed fields (set by calculateFifo Cloud Function) ===

  /** Realized gain/loss in EUR cents (only for sells) */
  realizedGainEur?: number | null;
  /** Total cost basis in EUR cents (only for sells) */
  costBasisEur?: number | null;
  /** AT: crypto acquired before 2021-03-01 (tax-free) */
  isAltbestand?: boolean | null;
  /** DE: crypto held > 1 year (tax-free) */
  isHoldingPeriodExempt?: boolean | null;
  /** Detailed FIFO lot assignments for this sell */
  fifoLotAssignments?: FifoLotAssignment[];
  /** Whether FIFO has been calculated for this trade */
  fifoCalculated?: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Filters for querying investment trades
 */
export interface InvestmentTradeFilters {
  sourceId?: string;
  tradeType?: TradeType;
  assetType?: AssetType;
  ticker?: string;
  dateFrom?: Date;
  dateTo?: Date;
}
