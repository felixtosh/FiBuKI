import type { TaxFile, FileFilters } from "@/types/file";

export type RawTaxFile = TaxFile;
export type FileFilterInput = FileFilters;

export interface FileFilterResult {
  rows: TaxFile[];
  /** Count of rows not marked as not-invoice, regardless of which filters are active. */
  invoiceCount: number;
}

export function applyFileFilters(
  rawFiles: TaxFile[],
  filters?: FileFilters,
): FileFilterResult;
