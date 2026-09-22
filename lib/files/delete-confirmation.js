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

module.exports = {
  fileDeleteConfirmation,
  bulkFileDeleteConfirmation,
};
