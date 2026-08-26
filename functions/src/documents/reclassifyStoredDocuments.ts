/**
 * A write path for the § 11 classifier (#204).
 *
 * The classifier shipped inert: `documentType` is written only at extraction
 * time, so nothing already stored carries one, the receipt-only chase queue
 * answers zero rows, and the scorer's duplicate-suppression rule has never
 * run against real data. The verdict exists on every read and is thrown away
 * every time, because nothing persists it.
 *
 * This re-runs the SAME classifier over stored records and persists the
 * answer. It regenerates no rules: `classifyFileRecord` and
 * `deriveDocumentationState` are the ones extraction and the transaction
 * trigger already use, so a sweep can never disagree with a fresh extraction.
 *
 * Files and transactions move together, in that order, in one call.
 * `documentationState` is derived only when a transaction is touched, so a
 * transaction holding no files never gets one at all — and splitting the two
 * would leave a window where a file reads `receipt` while its transaction
 * still says nothing. Both passes are planned in full before either is
 * written, so a read that fails takes nothing with it.
 *
 * The population is every record the caller owns, soft-deleted files
 * included: the classification is a property of the document, a restore does
 * not re-extract, and a file left out here would come back unclassified. The
 * write itself is inert for the file triggers — `matchFilePartner` and
 * `matchFileTransactions` gate on the extraction and partner-match flags, none
 * of which this touches, so a swept corpus does not re-run matching.
 *
 * It reads `recipientIdentityMatch` off the record like any other stored fact
 * and never recomputes it (#229): the comparison needs the user's identity
 * entities, which this sweep does not load, and guessing here would be the one
 * way a sweep COULD disagree with an extraction. A corpus written before #229
 * therefore classifies `unknown` on that axis, which demotes nothing. The
 * backfill for it is the identity sweep — `onUserDataUpdate` recomputes the
 * verdict and the classification together for every file the user owns.
 *
 * Two things it deliberately does not do:
 *  - it never touches an extraction field. Only the three classification
 *    fields are written, so a hand correction (#184) cannot be destroyed and
 *    no record is stamped as corrected when a machine merely re-read it.
 *  - it does not write a value that did not move. An unchanged write re-fires
 *    `onTransactionUpdate` for nothing, which is the loop every write path
 *    here is built to avoid — and it is what makes a second run free.
 */

import { getFirestore } from "firebase-admin/firestore";
import {
  classifyFileRecord,
  documentTypeFields,
  documentTypeFieldsChanged,
} from "./adapter";
import { deriveDocumentationState, documentationStateChanged } from "./documentationState";
import type {
  DocumentType,
  DocumentTypeReason,
  DocumentationState,
} from "./types";

const db = getFirestore();

const PAGE_SIZE = 500;
const MAX_BATCH_SIZE = 500;
/**
 * Hard ceiling on documents read per collection. Hitting it aborts rather
 * than truncating: a half-swept corpus derives transaction states from file
 * types that were never re-read, and the caller cannot tell which half ran.
 */
const MAX_SCAN = 20000;

export interface ReclassifyStoredDocumentsOptions {
  /**
   * Default **true**. Nothing is written unless the caller passes false — a
   * whole-corpus rewrite is not something to trip into.
   */
  dryRun?: boolean;
}

export interface ReclassifyFileSummary {
  /** Files read. */
  scanned: number;
  /** The verdict distribution — what the corpus reads as after this run. */
  byType: Record<DocumentType, number>;
  /** Why, one bucket per reason the classifier can give. */
  byReason: Record<DocumentTypeReason, number>;
  /** Verdicts only a re-extraction can improve, counted rather than hidden. */
  degraded: number;
  /** Files whose stored classification differs from the verdict. */
  changed: number;
  /** Files actually written. Zero on a dry run. */
  written: number;
}

export interface ReclassifyTransactionSummary {
  /** Transactions read. */
  scanned: number;
  /** The derived distribution — what the corpus reads as after this run. */
  byState: Record<DocumentationState, number>;
  /** Transactions whose stored state differs from the derivation. */
  changed: number;
  /** Transactions actually written. Zero on a dry run. */
  written: number;
}

export interface ReclassifyStoredDocumentsResult {
  dryRun: boolean;
  /** True only when writes actually happened. */
  applied: boolean;
  files: ReclassifyFileSummary;
  transactions: ReclassifyTransactionSummary;
}

/**
 * Zero-filled counters. Written as full object literals on purpose: TypeScript
 * then refuses to compile when a type, reason or state is added to the union
 * and not counted here, which is the only way this stays complete.
 */
function emptyTypeCounts(): Record<DocumentType, number> {
  return { invoice: 0, receipt: 0, other: 0, unknown: 0 };
}

function emptyReasonCounts(): Record<DocumentTypeReason, number> {
  return {
    "not-a-financial-document": 0,
    "no-gross-total": 0,
    "section-11-satisfied": 0,
    "zero-vat-with-stated-regime": 0,
    "receipt-designation": 0,
    "no-vat-no-invoice-identity": 0,
    "missing-decisive-elements": 0,
    "own-outgoing-document": 0,
    "foreign-recipient": 0,
    "legacy-record-undecidable": 0,
  };
}

function emptyStateCounts(): Record<DocumentationState, number> {
  return {
    invoice: 0,
    "receipt-only": 0,
    "no-receipt-category": 0,
    undocumented: 0,
    unknown: 0,
  };
}

interface PlannedWrite {
  ref: FirebaseFirestore.DocumentReference;
  updates: Record<string, unknown>;
}

/**
 * Page through one collection's rows for this user, oldest id first.
 *
 * Ordered by `__name__` because the sweep needs a stable total order over the
 * whole corpus and no field on either collection provides one.
 */
async function forEachOwnedDocument(
  collection: string,
  userId: string,
  visit: (doc: FirebaseFirestore.QueryDocumentSnapshot) => void
): Promise<number> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let scanned = 0;

  for (;;) {
    let query = db
      .collection(collection)
      .where("userId", "==", userId)
      .orderBy("__name__")
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      scanned++;
      visit(doc);
    }

    if (snapshot.size < PAGE_SIZE) break;
    if (scanned >= MAX_SCAN) {
      throw new Error(
        `Scanned ${scanned} ${collection} without reaching the end, above this tool's ceiling of ${MAX_SCAN}. ` +
        "Nothing further was read; a partial sweep would derive transaction states from files it never re-read."
      );
    }
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }

  return scanned;
}

async function commitWrites(writes: PlannedWrite[]): Promise<number> {
  let batch = db.batch();
  let pending = 0;

  for (const write of writes) {
    batch.update(write.ref, write.updates);
    pending++;

    if (pending >= MAX_BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();
  return writes.length;
}

export async function reclassifyStoredDocuments(
  userId: string,
  options: ReclassifyStoredDocumentsOptions = {}
): Promise<ReclassifyStoredDocumentsResult> {
  const dryRun = options.dryRun !== false;

  const files: ReclassifyFileSummary = {
    scanned: 0,
    byType: emptyTypeCounts(),
    byReason: emptyReasonCounts(),
    degraded: 0,
    changed: 0,
    written: 0,
  };

  /**
   * The verdict for every file this run classified, which is what the
   * transaction pass reads instead of re-reading the files collection. On a
   * dry run that is the only way the reported distribution can be the one the
   * live run would produce; on a live run it saves re-reading what was just
   * written.
   */
  const verdictByFileId = new Map<string, DocumentType>();
  const fileWrites: PlannedWrite[] = [];

  files.scanned = await forEachOwnedDocument("files", userId, (doc) => {
    const data = doc.data();
    const result = classifyFileRecord(data);

    verdictByFileId.set(doc.id, result.type);
    files.byType[result.type]++;
    files.byReason[result.basis.reason]++;
    if (result.basis.degraded) files.degraded++;

    if (!documentTypeFieldsChanged(data, result)) return;
    files.changed++;
    fileWrites.push({ ref: doc.ref, updates: documentTypeFields(result) });
  });

  const transactions: ReclassifyTransactionSummary = {
    scanned: 0,
    byState: emptyStateCounts(),
    changed: 0,
    written: 0,
  };
  const transactionWrites: PlannedWrite[] = [];

  transactions.scanned = await forEachOwnedDocument("transactions", userId, (doc) => {
    const data = doc.data() as {
      fileIds?: string[] | null;
      noReceiptCategoryId?: string | null;
      documentationState?: DocumentationState | null;
    };

    // A file id the sweep never saw is a dangling reference — a deleted file,
    // or one belonging to someone else — not an unclassified document. The
    // trigger's own reader drops those for the same reason: counting them as
    // unknown would park the transaction in the unknown bucket forever.
    const fileTypes = (data.fileIds ?? [])
      .map((fileId) => verdictByFileId.get(fileId))
      .filter((type): type is DocumentType => type !== undefined);

    const derived = deriveDocumentationState({
      fileTypes,
      hasNoReceiptCategory: !!data.noReceiptCategoryId,
    });

    transactions.byState[derived]++;
    if (!documentationStateChanged(data.documentationState, derived)) return;

    transactions.changed++;
    transactionWrites.push({ ref: doc.ref, updates: { documentationState: derived } });
  });

  // Both passes are planned before anything is written, so a read that fails
  // — the scan ceiling above, or a Firestore error mid-sweep — leaves the
  // corpus untouched rather than half-classified. The transaction pass never
  // re-reads the files collection (it derives from `verdictByFileId`), so
  // deferring the file writes costs nothing.
  if (!dryRun) {
    files.written = await commitWrites(fileWrites);
    transactions.written = await commitWrites(transactionWrites);
  }

  console.log(
    `[reclassifyStoredDocuments] user ${userId} ${dryRun ? "dry run" : "applied"}: ` +
    `${files.scanned} files (${files.changed} moved), ` +
    `${transactions.scanned} transactions (${transactions.changed} moved)`
  );

  return {
    dryRun,
    applied: !dryRun && files.written + transactions.written > 0,
    files,
    transactions,
  };
}
