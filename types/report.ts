import type { Timestamp } from "firebase/firestore";
import { TaxCountryCode } from "./user-data";

/**
 * Report period - either monthly or quarterly
 */
export interface ReportPeriod {
  year: number;
  /** For monthly: 1-12, for quarterly: 1-4 */
  period: number;
  type: "monthly" | "quarterly";
}

/**
 * Austrian VAT rates (Umsatzsteuer)
 * - 20%: Standard rate (Normalsteuersatz)
 * - 13%: Tourism, culture (ermäßigter Steuersatz)
 * - 10%: Food, books, public transport (ermäßigter Steuersatz)
 * - 0%: Exempt/Export
 */
export type AustrianVatRate = 20 | 13 | 10 | 0;

/**
 * German VAT rates (Umsatzsteuer)
 * - 19%: Standard rate
 * - 7%: Reduced rate (food, books, etc.)
 * - 0%: Exempt/Export
 */
export type GermanVatRate = 19 | 7 | 0;

/**
 * Swiss VAT rates (Mehrwertsteuer)
 * - 8.1%: Standard rate (as of 2024)
 * - 2.6%: Reduced rate
 * - 3.8%: Special rate (accommodation)
 * - 0%: Exempt/Export
 */
export type SwissVatRate = 8.1 | 2.6 | 3.8 | 0;

/**
 * VAT breakdown by rate
 */
export interface VatBreakdown {
  /** VAT rate as percentage */
  rate: number;
  /** Net amount in cents (before VAT) */
  netAmount: number;
  /** VAT amount in cents */
  vatAmount: number;
  /** Gross amount in cents (net + VAT) */
  grossAmount: number;
  /** Number of transactions */
  transactionCount: number;
}

/**
 * UVA Report status
 */
export type ReportStatus = "draft" | "validated" | "submitted" | "confirmed" | "error";

/**
 * Report readiness check result
 */
export interface ReportReadiness {
  isReady: boolean;
  totalTransactions: number;
  completeTransactions: number;
  incompleteTransactions: number;
  /** Transaction IDs that are incomplete */
  incompleteTransactionIds: string[];
  /** Percentage of completion (0-100) */
  completionPercentage: number;
  /** Issues that prevent submission */
  blockingIssues: ReportBlockingIssue[];
}

/**
 * Blocking issue that prevents report submission
 */
export interface ReportBlockingIssue {
  type: "missing_receipt" | "missing_vat_rate" | "missing_partner" | "unmatched_amount";
  message: string;
  transactionIds: string[];
  count: number;
}

/**
 * Austrian UVA (Umsatzsteuervoranmeldung) Report
 * Based on official Finanzamt Austria form U30
 */
export interface UVAReport {
  id: string;
  userId: string;

  /** Report period */
  period: ReportPeriod;

  /** Country code */
  country: TaxCountryCode;

  /** Current status */
  status: ReportStatus;

  // === REVENUE (Umsätze) ===

  /** Total taxable revenue (Lieferungen/Leistungen im Inland) */
  taxableRevenue: {
    /** KZ 000: 20% rate - Net amount */
    rate20Net: number;
    /** KZ 001: 20% rate - VAT amount */
    rate20Vat: number;
    /** KZ 006: 10% rate - Net amount */
    rate10Net: number;
    /** KZ 007: 10% rate - VAT amount */
    rate10Vat: number;
    /** KZ 029: 13% rate - Net amount */
    rate13Net: number;
    /** KZ 008: 13% rate - VAT amount */
    rate13Vat: number;
  };

  /** Exempt revenue (Steuerfreie Umsätze) */
  exemptRevenue: {
    /** KZ 011: Export deliveries (Ausfuhrlieferungen) */
    exports: number;
    /** KZ 017: EU deliveries (Innergemeinschaftliche Lieferungen) */
    euDeliveries: number;
    /** KZ 019: Other exempt revenue */
    other: number;
  };

  /** EU acquisitions (Innergemeinschaftliche Erwerbe) */
  euAcquisitions: {
    /** KZ 070: EU acquisitions - Net amount */
    netAmount: number;
    /** KZ 071: EU acquisitions - VAT amount (treated as both payable and deductible) */
    vatAmount: number;
  };

  // === INPUT VAT (Vorsteuer) ===

  /** Deductible input VAT */
  inputVat: {
    /** KZ 060: Standard input VAT from invoices */
    standard: number;
    /** KZ 061: Input VAT from EU acquisitions */
    euAcquisitions: number;
    /** KZ 083: Input VAT from imports */
    imports: number;
  };

  // === CALCULATED TOTALS ===

  /** KZ 095: Total VAT payable (before deductions) */
  totalVatPayable: number;

  /** KZ 090: Total deductible input VAT */
  totalInputVat: number;

  /** KZ 096: Remaining VAT payable (positive) or refund (negative) */
  vatBalance: number;

  // === BREAKDOWN ===

  /** Detailed breakdown by VAT rate */
  breakdown: VatBreakdown[];

  /** Transaction counts */
  transactionCount: {
    total: number;
    income: number;
    expense: number;
    complete: number;
    incomplete: number;
  };

  // === METADATA ===

  /** When the report was created */
  createdAt: Timestamp;

  /** When the report was last updated */
  updatedAt: Timestamp;

  /** When the report was submitted */
  submittedAt?: Timestamp;

  /** FinanzOnline reference number (after submission) */
  finanzonlineRef?: string;

  /** Error message if status is 'error' */
  errorMessage?: string;

  /** Notes/comments */
  notes?: string;
}

/**
 * Summary view of a report for listing
 */
export interface ReportSummary {
  id: string;
  period: ReportPeriod;
  country: TaxCountryCode;
  status: ReportStatus;
  vatBalance: number;
  transactionCount: number;
  completionPercentage: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Period format helpers
 */
export function formatPeriod(period: ReportPeriod): string {
  if (period.type === "monthly") {
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    return `${monthNames[period.period - 1]} ${period.year}`;
  } else {
    return `Q${period.period} ${period.year}`;
  }
}

export function formatPeriodShort(period: ReportPeriod): string {
  if (period.type === "monthly") {
    return `${period.period.toString().padStart(2, "0")}/${period.year}`;
  } else {
    return `Q${period.period}/${period.year}`;
  }
}

/**
 * Get the date range for a period
 */
export function getPeriodDateRange(period: ReportPeriod): { start: Date; end: Date } {
  if (period.type === "monthly") {
    const start = new Date(period.year, period.period - 1, 1);
    const end = new Date(period.year, period.period, 0, 23, 59, 59, 999);
    return { start, end };
  } else {
    const startMonth = (period.period - 1) * 3;
    const start = new Date(period.year, startMonth, 1);
    const end = new Date(period.year, startMonth + 3, 0, 23, 59, 59, 999);
    return { start, end };
  }
}

/**
 * Get the current period based on date
 */
export function getCurrentPeriod(type: "monthly" | "quarterly"): ReportPeriod {
  const now = new Date();
  if (type === "monthly") {
    // Return previous month (current month is not complete)
    const prevMonth = now.getMonth(); // 0-indexed, so this is "previous" month
    const year = prevMonth === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const month = prevMonth === 0 ? 12 : prevMonth;
    return { year, period: month, type: "monthly" };
  } else {
    // Return previous quarter
    const currentQuarter = Math.ceil((now.getMonth() + 1) / 3);
    const prevQuarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
    const year = currentQuarter === 1 ? now.getFullYear() - 1 : now.getFullYear();
    return { year, period: prevQuarter, type: "quarterly" };
  }
}

/**
 * Get deadline for UVA submission (Austria: 15th of 2nd month after period)
 */
export function getUvaDeadline(period: ReportPeriod): Date {
  if (period.type === "monthly") {
    // 15th of second month after the period
    return new Date(period.year, period.period + 1, 15);
  } else {
    // 15th of second month after quarter end
    const quarterEndMonth = period.period * 3;
    return new Date(period.year, quarterEndMonth + 1, 15);
  }
}

/**
 * Check if deadline has passed
 */
export function isDeadlinePassed(period: ReportPeriod): boolean {
  const deadline = getUvaDeadline(period);
  return new Date() > deadline;
}
