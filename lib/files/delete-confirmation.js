/**
 * The copy the Files page confirms a delete with.
 *
 * Deleting a File hides it and can be undone (#258, ADR-0006), so the wording
 * promises no permanence for any File — there is no longer a Gmail-only
 * sentence, because reversible is what delete means for every source now. What
 * it does still warn about is the part a Restore does not bring back: the
 * File's connections to transactions are dropped on delete and stay dropped.
 *
 * @param {string} fileName
 * @returns {string}
 */
function fileDeleteConfirmation(fileName) {
  return (
    `Delete "${fileName}"? It will be hidden and can be restored later. ` +
    `Its connections to transactions are removed and do not come back with it.`
  );
}

/**
 * The same promise for the Files page's bulk delete.
 *
 * @param {number} fileCount
 * @returns {string}
 */
function bulkFileDeleteConfirmation(fileCount) {
  const noun = fileCount === 1 ? "file" : "files";
  const pronoun = fileCount === 1 ? "It" : "They";
  return (
    `Delete ${fileCount} ${noun}? ${pronoun} will be hidden and can be restored later. ` +
    `Connections to transactions are removed and do not come back.`
  );
}

/**
 * The copy the deleted-files view confirms a Purge with (#268).
 *
 * Purge is the only act in the product that destroys anything, so this is the
 * one confirmation allowed to promise permanence. It names the count, and when
 * any of the selection is retention-relevant (`isRetentionRelevant` in
 * purge-policy.js) it carries the BAO § 132 warning — a warning, not a
 * refusal: retention is the taxpayer's duty, the user may proceed. Junk purges
 * without ceremony.
 *
 * @param {number} fileCount
 * @param {number} retentionRelevantCount files in the selection that warn
 * @returns {string}
 */
function purgeConfirmation(fileCount, retentionRelevantCount) {
  const noun = fileCount === 1 ? "file" : "files";
  const base =
    `Purge ${fileCount} ${noun}? The stored ${fileCount === 1 ? "document is" : "documents are"} ` +
    `destroyed for good. This cannot be undone.`;

  if (retentionRelevantCount <= 0) return base;

  const which =
    retentionRelevantCount === fileCount
      ? fileCount === 1
        ? "This file is a business record"
        : "These files are business records"
      : `${retentionRelevantCount} of them are business records`;

  return (
    `${base}\n\n${which} — attached to a transaction, or an invoice or receipt ` +
    `from the last 7 years. You are legally required to keep such records for ` +
    `7 years (BAO § 132). Purge anyway?`
  );
}

module.exports = {
  fileDeleteConfirmation,
  bulkFileDeleteConfirmation,
  purgeConfirmation,
};
