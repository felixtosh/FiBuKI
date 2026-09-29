/**
 * Which Files the Purge confirmation warns about (#268).
 *
 * Purge is allowed with a warning instead of a refusal: retention under
 * BAO § 132 is the taxpayer's duty, not the software's, so FiBuKI informs and
 * the user decides. A File is retention-relevant when it was ever attached to
 * a Transaction — attached means it documented a business line — or when it is
 * classified invoice/receipt and dated within the 7-year window. Junk (never
 * attached, Document Type `other`/`unknown`) purges without ceremony.
 *
 * The warning is confirmation copy, not a gate: the server-side Purge refuses
 * only FiBuKI-generated invoice documents and Files that are not deleted.
 */

/**
 * @param {unknown} value Firestore Timestamp ({toDate}) or Date
 * @returns {Date | null}
 */
function toDateSafe(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  return null;
}

/**
 * @param {import("./purge-policy").PurgePolicyFile} file
 * @param {Date} [now]
 * @returns {boolean}
 */
function isRetentionRelevant(file, now = new Date()) {
  const attachedNow = Array.isArray(file.transactionIds) && file.transactionIds.length > 0;
  // Deleting clears the attachment fields, so the delete stamps this instead.
  const attachedOnce = file.hadTransactionConnections === true;
  if (attachedNow || attachedOnce) return true;

  const type = file.documentType;
  if (type !== "invoice" && type !== "receipt") return false;

  const date = toDateSafe(file.extractedDate);
  // An undated invoice/receipt warns: the window cannot be shown to have passed.
  if (!date) return true;

  const windowStart = new Date(now);
  windowStart.setFullYear(windowStart.getFullYear() - 7);
  return date >= windowStart;
}

module.exports = {
  isRetentionRelevant,
};
