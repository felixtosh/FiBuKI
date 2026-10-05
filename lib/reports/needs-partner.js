/**
 * Whether the report's readiness check asks for a Partner on a Transaction.
 *
 * A line over 100 EUR should name who the money went to or came from. A line
 * a Category explains is exempt: an own transfer, a tax payment or a lost
 * receipt has no counterparty worth naming, and flagging it buried the lines
 * that did need one.
 *
 * @param {{ amount: number, partnerId?: string | null, noReceiptCategoryId?: string | null }} tx
 * @returns {boolean}
 */
export function needsPartner(tx) {
  if (tx.partnerId || tx.noReceiptCategoryId) return false;
  return Math.abs(tx.amount) > 10000;
}
