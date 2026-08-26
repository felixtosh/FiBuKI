/**
 * The receipt-only chase queue (#207) — pure row building and ordering.
 *
 * The queue already exists as the `list_transactions_missing_invoice` agent
 * tool (`functions/src/tools/handlers.ts`). This is the same queue for a
 * human: the same membership test, the same row fields and the same
 * `minAmount` semantics, so the operator and the agent can never be looking
 * at different work lists.
 *
 * Nothing here decides anything. `deriveDocumentationState` on the backend
 * decides what a transaction is documented by, the § 11 classifier decides
 * what each file is, and both verdicts are stored. This module selects and
 * orders.
 *
 * Membership is `documentationState === "receipt-only"` and nothing else. An
 * absent state is NOT a member: it means the row has never been checked, and
 * putting never-checked rows in a chase queue would fill it with work that
 * may not exist. Until the backfill runs the queue is honestly empty.
 *
 * All amounts are integer cents.
 */

/** The one state that is a bookkeeping gap worth chasing. */
const CHASEABLE_STATE = "receipt-only";

/**
 * Firestore Timestamp, Date, ISO string or epoch millis — the transaction
 * date reaches this module in whichever shape its record was written in.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !isNaN(date.getTime()) ? date : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * @param {import("./chase-queue").ChaseQueueTransaction} transaction
 * @param {Map<string, import("./chase-queue").ChaseQueueFile>} filesById
 * @returns {import("./chase-queue").ChaseQueueRow}
 */
function buildRow(transaction, filesById) {
  const fileIds = Array.isArray(transaction.fileIds) ? transaction.fileIds : [];

  // A file id with no record behind it is dropped rather than rendered as a
  // blank document — the same thing the agent tool does with a missing doc.
  const documents = fileIds
    .map((fileId) => {
      const file = filesById.get(fileId);
      if (!file) return null;
      return {
        fileId,
        fileName: file.fileName ?? null,
        documentType: file.documentType ?? null,
        missingElements: file.documentTypeMissingElements ?? [],
        basisReason: file.documentTypeBasis ? file.documentTypeBasis.reason ?? null : null,
      };
    })
    .filter((document) => document !== null);

  // Union across the attached documents, deduplicated but left in the order
  // the records carry them — the statute order is applied when they are
  // named, by the same module the file surfaces name them with.
  const missingElements = [
    ...new Set(documents.flatMap((document) => document.missingElements)),
  ];

  return {
    id: transaction.id,
    date: toDate(transaction.date),
    amount: transaction.amount ?? 0,
    currency: transaction.currency || "EUR",
    name: transaction.name ?? null,
    partner: transaction.partner ?? null,
    partnerId: transaction.partnerId ?? null,
    vendor: transaction.partner || transaction.name || null,
    documentationState: transaction.documentationState ?? null,
    missingElements,
    documents,
  };
}

/**
 * Biggest deduction first. That is the whole ordering argument: a 4 EUR
 * payment confirmation and a 900 EUR one cost the same mail to chase, and
 * only one of them is worth the operator's morning.
 */
function byAmountDesc(a, b) {
  const diff = Math.abs(b.amount) - Math.abs(a.amount);
  if (diff !== 0) return diff;
  return byDateDesc(a, b);
}

function byDateDesc(a, b) {
  const timeA = a.date ? a.date.getTime() : -Infinity;
  const timeB = b.date ? b.date.getTime() : -Infinity;
  if (timeA !== timeB) return timeB - timeA;
  // Stable across reloads: two rows on the same day must not swap places.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {import("./chase-queue").ChaseQueueTransaction[]} transactions
 * @param {import("./chase-queue").ChaseQueueFile[]} files
 * @param {import("./chase-queue").ChaseQueueOptions} options
 * @returns {import("./chase-queue").ChaseQueueResult}
 */
function buildChaseQueue(transactions, files, options = {}) {
  const { minAmount, sort = "amount" } = options;

  const filesById = new Map(
    (Array.isArray(files) ? files : []).map((file) => [file.id, file]),
  );

  const all = (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => transaction.documentationState === CHASEABLE_STATE)
    .map((transaction) => buildRow(transaction, filesById));

  // Absolute value, matching the tool: an income line documented by a receipt
  // only is still a gap, and its sign says nothing about its size.
  const rows =
    minAmount === undefined || minAmount === null
      ? all
      : all.filter((row) => Math.abs(row.amount) >= minAmount);

  rows.sort(sort === "date" ? byDateDesc : byAmountDesc);

  return {
    rows,
    // Before the amount filter, so the view can say what the filter is hiding
    // rather than letting a threshold quietly shrink the queue.
    totalCount: all.length,
    totalAmount: rows.reduce((sum, row) => sum + Math.abs(row.amount), 0),
    // The currencies the shown rows are actually in. `totalAmount` is a sum of
    // cents and means nothing across two of them — no rate is applied here,
    // and the caller has to refuse to print a total rather than label a mixed
    // sum EUR.
    currencies: [...new Set(rows.map((row) => row.currency))].sort(),
  };
}

/**
 * How many transactions the queue holds, without building any rows — the
 * count a toolbar shows next to the way in.
 *
 * @param {import("./chase-queue").ChaseQueueTransaction[]} transactions
 * @returns {number}
 */
function countChaseQueue(transactions) {
  if (!Array.isArray(transactions)) return 0;
  return transactions.filter((t) => t.documentationState === CHASEABLE_STATE).length;
}

module.exports = {
  CHASEABLE_STATE,
  buildChaseQueue,
  countChaseQueue,
};
