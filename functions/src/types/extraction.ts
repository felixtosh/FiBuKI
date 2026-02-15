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

export interface ExtractedData {
  date: string | null; // ISO format YYYY-MM-DD
  amount: number | null; // cents
  currency: string | null;
  vatPercent: number | null;
  lineItems?: ExtractedLineItem[] | null;
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
