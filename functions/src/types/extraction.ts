/**
 * Shared extraction types for document processing.
 * Used by both Gemini and legacy Claude parsers.
 */

/**
 * Normalized entity data (issuer or recipient)
 */
export interface ExtractedEntity {
  name: string | null;
  vatId: string | null;
  address: string | null;
  iban: string | null;
  website: string | null;
}

export interface ExtractedLineItem {
  description: string;
  quantity?: number | null;
  /** Net unit price before VAT (in cents) */
  unitPrice?: number | null;
  /** VAT rate for this line item (0-100), null when unknown */
  vatPercent: number | null;
  /** VAT amount in cents */
  vatAmount: number;
  /** Line amount in cents (preferably gross; some extractions provide net) */
  amount: number;
}

/**
 * One row of the document's own printed VAT summary block (fork #67,
 * spec §6 item 3) — "20% MwSt. 45,00 / 9,00 / 54,00", the per-rate
 * subtotals most Austrian §11 receipts carry.
 *
 * These are READ OFF the document, never computed from line items: a
 * single printed subtotal is far more OCR-robust than the sum of N
 * itemised rows, and §11 makes the per-rate totals the legally
 * sufficient record on their own.
 */
export interface ExtractedRateGroup {
  /** VAT rate 0-100 */
  rate: number;
  /** Net (excl. VAT) subtotal for this rate, cents */
  net: number;
  /** VAT amount for this rate, cents */
  vat: number;
  /** Gross (incl. VAT) subtotal for this rate, cents */
  gross: number;
}

export interface ExtractedData {
  date: string | null; // ISO format YYYY-MM-DD
  amount: number | null; // cents
  /**
   * Freiwilliges Trinkgeld the document prints on its own line (#172), cents.
   * Kept OUT of `amount`: a voluntary tip to the staff is not Entgelt for the
   * restaurant's supply, so it is outside the scope of VAT and carries no
   * Vorsteuer. `amount` stays the VAT-bearing Summe that the printed rate
   * groups add up to; the card was charged `amount + tipAmount`.
   * null when the document prints no tip line.
   */
  tipAmount?: number | null;
  currency: string | null;
  vatPercent: number | null;
  lineItems?: ExtractedLineItem[] | null;
  /** Printed per-rate VAT summary block, when the document shows one */
  rateGroups?: ExtractedRateGroup[] | null;
  /**
   * The document's own printed self-designation — the literal heading it
   * gives itself ("Rechnung", "Invoice", "Quittung", "Zahlungsbestätigung",
   * "Receipt", "Gutschrift"). Transcribed, never inferred; null when the
   * document prints no such heading (#104).
   *
   * Evidence, not verdict: a document titled "Rechnung" that fails the § 11
   * test at its amount is still classified on its structure.
   */
  selfDesignation: string | null;
  /**
   * The sequential invoice number § 11 Abs 1 lit. h requires above 400 EUR.
   * Transcribed, never invented; null when the document prints none (#104).
   */
  invoiceNumber: string | null;
  partner: string | null;
  vatId: string | null; // VAT ID (e.g., ATU12345678, DE123456789)
  iban: string | null; // IBAN if visible
  address: string | null; // Full address as single string
  website: string | null; // Vendor website domain (e.g., "company.de")
  confidence: number;
  fieldSpans: Record<string, string>; // field -> matched text from document
  // Entity fields for counterparty determination
  issuer: ExtractedEntity | null;
  recipient: ExtractedEntity | null;
}
