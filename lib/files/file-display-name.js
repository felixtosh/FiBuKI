/**
 * How the app names a File to the user (#247).
 *
 * A File is identified by its extracted invoice number, not by whatever it
 * happened to be called when it arrived. The invoice number is null on
 * receipts, `other` and `unknown` documents and on every record extracted
 * before the field existed, so this is a fallback chain: invoice number, then
 * file name. Partner and invoice date are deliberately not in the chain; both
 * have their own columns.
 *
 * Use the raw `fileName` wherever the sentence means the actual file on disk
 * (download attribute, delete confirmation, upload and duplicate messages).
 *
 * @param {{ fileName: string, extractedInvoiceNumber?: string | null }} file
 * @returns {string}
 */
function fileDisplayName(file) {
  const invoiceNumber = file.extractedInvoiceNumber?.trim();
  return invoiceNumber || file.fileName;
}

/**
 * The processing status the name cell shows, if any, as a key under
 * `files.processing` in the messages.
 *
 * An Extraction waits in a queue before a worker picks it up (#603):
 * `queued` until `extractionStartedAt` is set, `analyzing` / `parsing` after.
 * A failed Extraction says so rather than looking busy forever.
 *
 * @param {import("./file-display-name").FileProcessingInput} file
 * @returns {{ status: import("./file-display-name").FileProcessingStatus, busy: boolean } | null}
 */
function fileProcessingStatus(file) {
  if (file.extractionError) return { status: "failed", busy: false };
  if (!file.extractionComplete && !file.extractionStartedAt) {
    return { status: "queued", busy: true };
  }
  if (!file.classificationComplete) return { status: "analyzing", busy: true };
  if (file.isNotInvoice) return { status: "notInvoice", busy: false };
  if (!file.extractionComplete) return { status: "parsing", busy: true };
  return null;
}

/**
 * The Files table name cell: the display name, plus a second line. A
 * processing status wins the second line; otherwise, when the invoice number
 * is showing, the file name is the second line so it is never unrecoverable.
 *
 * @param {import("./file-display-name").FileDisplayNameInput & import("./file-display-name").FileProcessingInput} file
 * @returns {import("./file-display-name").FileNameCell}
 */
function describeFileNameCell(file) {
  const name = fileDisplayName(file);
  const status = fileProcessingStatus(file);
  if (status) {
    return { name, secondLine: { kind: "status", status: status.status, busy: status.busy } };
  }
  if (name !== file.fileName) {
    return { name, secondLine: { kind: "fileName", text: file.fileName } };
  }
  return { name, secondLine: null };
}

module.exports = {
  fileDisplayName,
  fileProcessingStatus,
  describeFileNameCell,
};
