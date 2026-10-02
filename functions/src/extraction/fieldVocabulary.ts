/**
 * The fixed vocabulary of extracted fields (#252, #540).
 *
 * Every field the extraction keeps beside the fixed top-level slots carries a
 * KEY from this list. The key is what the record means; the UI names it from
 * the translation files by key (`files.extracted.fields.<key>`), so a field
 * reads the same in English and German whatever the document printed. The
 * printed `label` survives only as evidence for a person comparing the record
 * against the PDF, never as the display name.
 *
 * Kept in its own module, free of the Vertex client, so the correction
 * callable can enforce the same list without importing the parser. Mirrored by
 * hand in `types/extraction-fields.ts` (functions/tsconfig pins
 * `rootDir: "src"`); `fieldVocabulary.sync.test.ts` fails when they drift.
 *
 * Scope: what matters for matching a document to a Transaction and a Partner,
 * and for getting its VAT right. A table number, a till id or a loyalty
 * number is none of those, and has no key. A party is never a field here
 * either: issuer, recipient and Invoicing Agent have their own slots.
 */
export const ADDITIONAL_FIELD_KEYS = [
  "invoiceNumber",
  "customerNumber",
  "dueDate",
  "debitDate",
  "serviceDate",
  "paymentTerms",
  "paymentMethod",
  "orderNumber",
  "deliveryNoteNumber",
  "referenceNumber",
  "poNumber",
] as const;

export type AdditionalFieldKey = (typeof ADDITIONAL_FIELD_KEYS)[number];

const ADDITIONAL_FIELD_KEY_SET: ReadonlySet<string> = new Set(ADDITIONAL_FIELD_KEYS);

export function isAdditionalFieldKey(value: unknown): value is AdditionalFieldKey {
  return typeof value === "string" && ADDITIONAL_FIELD_KEY_SET.has(value);
}

/**
 * The fixed values `paymentMethod` carries (#540), so the UI can name it in
 * every language and matching can tell a cash Beleg (which never meets a
 * bank line) from a card one. A wording that maps to none of them is "other".
 */
export const PAYMENT_METHODS = ["cash", "card", "bankTransfer", "directDebit", "paypal", "other"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function normalizePaymentMethod(value: string): PaymentMethod {
  const compact = value.trim();
  return (PAYMENT_METHODS as readonly string[]).includes(compact) ? (compact as PaymentMethod) : "other";
}
