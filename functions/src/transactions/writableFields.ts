/**
 * What the Transaction update callables write, and nothing else (#621).
 *
 * The payload is whatever JSON the caller sent, and the old copy loops
 * forwarded every key of it into the update: a User could set `userId` on
 * their own Transaction and hand it to another User (into that User's list,
 * UVA period and BMD export), or rewrite the bank figures. The request types
 * are the contract; these sets are the contract enforced, the same way
 * `updateFile` does it (#205).
 *
 * Never writable here: the owner (`userId`), the bank figures (`sourceId`,
 * `amount`, `date`, `currency`, `name`, `dedupeHash`, `_original`,
 * `importJobId`), which change only through the import paths, and the
 * timestamps (`createdAt`, `updatedAt`), which the server stamps.
 *
 * The browser's `TransactionUpdate` type mirrors `WRITABLE_FIELDS` by hand.
 */

import { HttpsError } from "../utils/createCallable";

/** What `bulkUpdateTransactions` writes: the same values onto many rows. */
export const BULK_WRITABLE_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "isComplete",
  "partnerId",
  "partnerType",
  "partnerMatchConfidence",
  "partnerMatchedBy",
  "noReceiptCategoryId",
  "noReceiptCategoryTemplateId",
  "noReceiptCategoryMatchedBy",
  "noReceiptCategoryConfidence",
]);

/** What `updateTransaction` writes on one row. */
export const WRITABLE_FIELDS: ReadonlySet<string> = new Set([
  ...BULK_WRITABLE_FIELDS,
  "receiptLostEntry",
  "rejectedFileIds",
  "aiSearchQueries",
  "aiSearchQueriesForPartnerId",
  "vatRate",
  "vatAmount",
  "isEuTransaction",
  "isReverseCharge",
  "foreignSupplyKind",
  "saleSupplyKind",
]);

/**
 * Refuse a request carrying any key outside `writable`. Refusing loudly beats
 * stripping silently: a stripped key looks like a write that worked.
 */
export function assertWritableFields(
  callable: string,
  data: unknown,
  writable: ReadonlySet<string>
): asserts data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "data must be an object of fields to update");
  }
  const refused = Object.keys(data).filter(
    (key) => !writable.has(key) && (data as Record<string, unknown>)[key] !== undefined
  );
  if (refused.length > 0) {
    throw new HttpsError("invalid-argument", `${callable} does not write ${refused.join(", ")}`);
  }
}
