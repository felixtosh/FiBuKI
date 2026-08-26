/**
 * Projection of the new UVA result onto the legacy UVAReportData shape the
 * existing preview and PDF export render. The figures are the corrected
 * ones — only the container shape is legacy. New consumers should read
 * UvaReportResult directly.
 */

import { OUTPUT_BASE_KZ } from "./calculateUva";
import type { UvaReportResult } from "./types";

export interface TransactionStats {
  total: number;
  income: number;
  expense: number;
  complete: number;
  incomplete: number;
}

export interface LegacyUvaReportData {
  taxableRevenue: {
    rate20Net: number;
    rate20Vat: number;
    rate10Net: number;
    rate10Vat: number;
    rate13Net: number;
    rate13Vat: number;
  };
  exemptRevenue: { exports: number; euDeliveries: number; other: number };
  euAcquisitions: { netAmount: number; vatAmount: number };
  inputVat: { standard: number; euAcquisitions: number; imports: number };
  totalVatPayable: number;
  totalInputVat: number;
  vatBalance: number;
  breakdown: Array<{
    rate: number;
    netAmount: number;
    vatAmount: number;
    grossAmount: number;
    transactionCount: number;
  }>;
  transactionCount: TransactionStats;
}

export function toLegacyReportData(
  result: UvaReportResult,
  stats: TransactionStats
): LegacyUvaReportData {
  const byRate = new Map(result.outputVatByRate.map((r) => [r.rate, r]));
  const rate = (r: number) => byRate.get(r) ?? { rate: r, base: 0, vat: 0 };
  const kz = (code: string) => result.kennzahlen[code]?.value ?? 0;

  return {
    taxableRevenue: {
      rate20Net: rate(20).base,
      rate20Vat: rate(20).vat,
      rate10Net: rate(10).base,
      rate10Vat: rate(10).vat,
      rate13Net: rate(13).base,
      rate13Vat: rate(13).vat,
    },
    exemptRevenue: {
      exports: kz("011"),
      euDeliveries: kz("017"),
      other: 0,
    },
    euAcquisitions: { netAmount: kz("070"), vatAmount: kz("065") },
    inputVat: {
      standard: kz("060"),
      euAcquisitions: kz("065"),
      imports: kz("061"),
    },
    totalVatPayable: result.totalOutputVat,
    totalInputVat: result.totalInputVat,
    vatBalance: result.balance,
    breakdown: result.outputVatByRate.map((r) => ({
      rate: r.rate,
      netAmount: r.base,
      vatAmount: r.vat,
      grossAmount: r.base + r.vat,
      transactionCount:
        result.kennzahlen[r.rate === 0 ? "011" : outputKzFor(r.rate)]
          ? contributionCount(result, r.rate)
          : 0,
    })),
    transactionCount: stats,
  };
}

function outputKzFor(rate: number): string {
  return OUTPUT_BASE_KZ[rate] ?? "";
}

function contributionCount(result: UvaReportResult, rate: number): number {
  const code = rate === 0 ? "011" : outputKzFor(rate);
  const contributions = result.kennzahlen[code]?.contributions ?? {};
  return Object.values(contributions).reduce((s, n) => s + (n ?? 0), 0);
}
