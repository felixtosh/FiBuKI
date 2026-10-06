export interface NeedsPartnerInput {
  amount: number;
  partnerId?: string | null;
  noReceiptCategoryId?: string | null;
}

/** Whether the readiness check asks for a Partner: over 100 EUR, no Partner, no Category. */
export function needsPartner(tx: NeedsPartnerInput): boolean;
