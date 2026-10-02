/**
 * The fixed vocabulary of extracted fields (#252, #540), frontend copy.
 *
 * Mirrors functions/src/extraction/fieldVocabulary.ts by hand: functions'
 * tsconfig pins `rootDir: "src"`, so neither tree can import the other.
 * functions/src/extraction/fieldVocabulary.sync.test.ts fails when they drift.
 *
 * The UI names a field by its key, from `files.extracted.fields.<key>` in
 * messages/{en,de}.json, never by the label the document printed.
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

export function isAdditionalFieldKey(value: unknown): value is AdditionalFieldKey {
  return typeof value === "string" && (ADDITIONAL_FIELD_KEYS as readonly string[]).includes(value);
}

/** The fixed values of `paymentMethod`, named by `files.extracted.paymentMethods.<value>`. */
export const PAYMENT_METHODS = ["cash", "card", "bankTransfer", "directDebit", "paypal", "other"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}
