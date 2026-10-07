/**
 * A Copy (#162, ADR-0010): a second File of a document FiBuKI already holds.
 *
 * A Copy points at exactly one other File, its original, and holds no File
 * Connection, so the original alone carries Coverage, the input VAT and the
 * BMD Export. Every reader of File Connections stays as it was: connected
 * means counted. What this module adds is the state itself and the three
 * acts that change it — mark, "Not a Copy" (undo or decline), and "Make this
 * the original" — shared by the callables, the MCP tools and the system's own
 * Copy check, so a Copy recorded by a click, by an agent and by the check end
 * up in the identical state.
 *
 * Whether a marked File is a Copy right now is derived on read: only while
 * its original is live (not deleted, not purged). A deleted original turns
 * its Copies back into ordinary Files without anything being written, and a
 * restore turns them back into Copies.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { normalizeCompanyName } from "../utils/partner-matcher";
import { isGeneratedInvoiceFile } from "./generatedInvoiceGuard";
import { buildUnmarkNotInvoiceUpdates, queueExtractionAfterUnmark, unmarkRefusal } from "./notInvoiceOps";
import { rematchRevertedTransactions } from "../matching/partnerProvenance";
import { planCopyMove } from "../fileConnections/writer";
import { pairedForCopyCheck } from "../receiptPairs/pairMatcher";
import { activityEntry, logActivity } from "../utils/activity";

type Data = FirebaseFirestore.DocumentData;
type Db = FirebaseFirestore.Firestore;

export type CopyRecordedBy = "system" | "user";

/** Why the system only suggested a Copy instead of recording it. */
export type CopySuggestionReason =
  /** Marking it would take a File Connection apart: only a person may. */
  | "connected"
  /** Issuer, amount and date agree, but an invoice number is missing. */
  | "no-invoice-number"
  /** The one-time pass: the two Files share their bytes (from before #182). */
  | "same-content"
  /** The one-time pass: a File hidden as "not an invoice" that names the original. */
  | "marked-not-invoice";

/** The fields a mark writes and an undo clears. */
export const CLEARED_COPY_MARK = {
  copyOfFileId: null,
  copyRecordedBy: null,
  copyRecordedAt: null,
};

// ============================================================================
// Reading the state
// ============================================================================

/** A File the user can still see: not deleted, not purged. */
export function isLiveFile(data: Data | undefined | null): boolean {
  return !!data && !data.deletedAt && !data.purgedAt;
}

export function isConnectedFile(data: Data | undefined | null): boolean {
  return Array.isArray(data?.transactionIds) && data!.transactionIds.length > 0;
}

/**
 * Whether a File is a Copy right now, given its original's record (or
 * undefined when that record is gone). The mark alone is not enough: a Copy
 * whose original is deleted is an ordinary File again.
 */
export function isLiveCopy(
  data: Data | undefined | null,
  original: Data | undefined | null
): boolean {
  if (!data || typeof data.copyOfFileId !== "string" || !data.copyOfFileId) return false;
  if (!original || original.userId !== data.userId) return false;
  return isLiveFile(original);
}

/**
 * Of the given Files, the ids that are Copies right now. Reads each distinct
 * original once; Files carrying no mark cost nothing.
 */
export async function liveCopyIds(
  db: Db,
  files: Array<{ id: string; data: Data }>
): Promise<Set<string>> {
  const marked = files.filter((f) => typeof f.data.copyOfFileId === "string" && f.data.copyOfFileId);
  if (marked.length === 0) return new Set();
  const originalIds = [...new Set(marked.map((f) => f.data.copyOfFileId as string))];
  const snaps = await db.getAll(...originalIds.map((id) => db.collection("files").doc(id)));
  const originals = new Map(snaps.map((s) => [s.id, s.exists ? s.data() : undefined]));
  return new Set(
    marked
      .filter((f) => isLiveCopy(f.data, originals.get(f.data.copyOfFileId as string)))
      .map((f) => f.id)
  );
}

export const COPY_CONNECT_ERROR = "COPY_HOLDS_NO_CONNECTION";

/** Why a connect of a live Copy is refused. */
export function copyRefusalMessage(originalId: string, original: Data | undefined): string {
  const name = (typeof original?.fileName === "string" && original.fileName) || originalId;
  return (
    `${COPY_CONNECT_ERROR}: this File is a Copy of "${name}" (${originalId}), and a Copy holds no ` +
    "File Connection. Connect the original, or make this File the original first."
  );
}

/** Whether a person ruled this pair "not a Copy", from either side. */
export function ruledNotCopy(a: { id: string; data: Data }, b: { id: string; data: Data }): boolean {
  const aRulings: unknown[] = Array.isArray(a.data.notCopyOfFileIds) ? a.data.notCopyOfFileIds : [];
  const bRulings: unknown[] = Array.isArray(b.data.notCopyOfFileIds) ? b.data.notCopyOfFileIds : [];
  return aRulings.includes(b.id) || bRulings.includes(a.id);
}

// ============================================================================
// Which File is the original
// ============================================================================

function createdMillis(data: Data): number {
  const v = data.createdAt ?? data.uploadedAt;
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v && typeof v.toDate === "function") return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  return Number.POSITIVE_INFINITY;
}

/**
 * Of two Files of one document, which is the original: a FiBuKI-generated
 * invoice (ADR-0006), otherwise the one holding a File Connection, otherwise
 * the earlier one. Null when both are generated invoices: two documents FiBuKI
 * issued are never Copies of each other.
 */
export function pickOriginal<T extends { id: string; data: Data }>(
  a: T,
  b: T
): { original: T; copy: T } | null {
  const aGen = isGeneratedInvoiceFile(a.data);
  const bGen = isGeneratedInvoiceFile(b.data);
  if (aGen && bGen) return null;
  if (aGen !== bGen) return aGen ? { original: a, copy: b } : { original: b, copy: a };

  const aConn = isConnectedFile(a.data);
  const bConn = isConnectedFile(b.data);
  if (aConn !== bConn) return aConn ? { original: a, copy: b } : { original: b, copy: a };

  const aAt = createdMillis(a.data);
  const bAt = createdMillis(b.data);
  if (aAt !== bAt) return aAt < bAt ? { original: a, copy: b } : { original: b, copy: a };
  return a.id < b.id ? { original: a, copy: b } : { original: b, copy: a };
}

// ============================================================================
// The evidence
// ============================================================================

export interface CopyEvidence {
  vatId: string | null;
  issuerName: string | null;
  invoiceNumber: string | null;
  /** Gross, in cents. */
  amount: number | null;
  currency: string;
  /** The Vienna calendar day, YYYY-MM-DD. */
  date: string | null;
}

function normalizeVat(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n || null;
}

function normalizeInvoiceNumber(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = String(v).toUpperCase().replace(/\s+/g, "");
  return n || null;
}

function dayOf(v: unknown): string | null {
  if (!v) return null;
  const d =
    typeof (v as { toDate?: unknown }).toDate === "function"
      ? (v as { toDate: () => Date }).toDate()
      : v instanceof Date
        ? v
        : null;
  if (!d || isNaN(d.getTime())) return null;
  // Stored dates are UTC midnight of the Vienna day: read the UTC date part.
  return d.toISOString().slice(0, 10);
}

/**
 * What the Copy check compares on one File. A FiBuKI-generated invoice skips
 * Extraction, so its number comes from the invoice record (ADR-0006); its
 * total and date are already on the File.
 */
export function copyEvidenceOf(data: Data, generatedInvoiceNumber?: string | null): CopyEvidence {
  const issuer = (data.extractedIssuer ?? null) as { name?: string | null; vatId?: string | null } | null;
  const name = issuer?.name ?? (data.invoiceDirection === "outgoing" ? null : data.extractedPartner) ?? null;
  return {
    vatId: normalizeVat(issuer?.vatId),
    issuerName: typeof name === "string" && normalizeCompanyName(name) ? normalizeCompanyName(name) : null,
    invoiceNumber: normalizeInvoiceNumber(generatedInvoiceNumber ?? data.extractedInvoiceNumber),
    amount: typeof data.extractedAmount === "number" ? data.extractedAmount : null,
    currency: typeof data.extractedCurrency === "string" && data.extractedCurrency ? data.extractedCurrency.toUpperCase() : "EUR",
    date: dayOf(data.extractedDate),
  };
}

/**
 * How strongly two Files are one document.
 *
 * - "exact": issuer (the VAT ID when both carry one, otherwise the normalised
 *   name), a non-empty invoice number on both sides, the gross amount to the
 *   cent and the date all agree. Strong enough for the system to record a
 *   Copy on its own.
 * - "no-invoice-number": issuer, amount and date agree, and the invoice number
 *   is missing on at least one side. Only ever suggested.
 * - null: not the same document, or not enough to tell.
 */
export function compareCopyEvidence(a: CopyEvidence, b: CopyEvidence): "exact" | "no-invoice-number" | null {
  if (a.amount === null || b.amount === null || a.amount !== b.amount) return null;
  if (a.currency !== b.currency) return null;
  if (!a.date || !b.date || a.date !== b.date) return null;

  if (a.vatId && b.vatId) {
    if (a.vatId !== b.vatId) return null;
  } else if (!a.issuerName || !b.issuerName || a.issuerName !== b.issuerName) {
    return null;
  }

  if (a.invoiceNumber && b.invoiceNumber) {
    return a.invoiceNumber === b.invoiceNumber ? "exact" : null;
  }
  return "no-invoice-number";
}

// ============================================================================
// The acts
// ============================================================================

interface Snap {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data: Data;
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpsError("invalid-argument", `${name} is required`);
  }
  return value;
}

/** A foreign id answers exactly like a missing one. */
async function readOwnedFile(
  tx: FirebaseFirestore.Transaction,
  db: Db,
  userId: string,
  fileId: string
): Promise<Snap> {
  const ref = db.collection("files").doc(fileId);
  const snap = await tx.get(ref);
  const data = snap.exists ? snap.data() : undefined;
  if (!data || data.userId !== userId || data.purgedAt) {
    throw new HttpsError("not-found", "File not found");
  }
  return { id: fileId, ref, data };
}

function displayName(f: Snap): string {
  return (typeof f.data.fileName === "string" && f.data.fileName) || f.id;
}

/**
 * Make `copy` a Copy of `original`, inside a transaction the caller opened.
 * All reads happen first, then all writes, as a Firestore transaction needs.
 *
 * - The mark is written on `copy`; `original` loses any mark of its own (this
 *   is how "Make this the original" swaps the two).
 * - Copies of `copy` follow it to `original`, so a chain collapses to the root.
 * - Each File Connection `copy` holds is taken apart. Where `original` is not
 *   connected to that Transaction, the Connection moves to `original`, so no
 *   Transaction loses the document. Neither is a Rejection: the pair was never
 *   wrong.
 */
async function applyCopy(
  tx: FirebaseFirestore.Transaction,
  db: Db,
  userId: string,
  copy: Snap,
  original: Snap,
  recordedBy: CopyRecordedBy,
  extraCopyUpdates: Record<string, unknown> = {}
): Promise<{ moved: string[]; dropped: string[]; rematch: Array<string | null> }> {
  const followersSnap = await tx.get(
    db.collection("files").where("userId", "==", userId).where("copyOfFileId", "==", copy.id)
  );
  // The File Connections move through their one writer (#612).
  const move = await planCopyMove(tx, db, userId, copy, original, {
    recordedBy,
    copyName: displayName(copy),
    originalName: displayName(original),
  });

  // ---- writes ----
  const now = Timestamp.now();
  move.write(tx);

  for (const follower of followersSnap.docs) {
    if (follower.id === original.id) continue;
    tx.update(follower.ref, { copyOfFileId: original.id, updatedAt: now });
  }

  const originalUpdate: Record<string, unknown> = { ...CLEARED_COPY_MARK, copySuggestion: null, updatedAt: now };
  if (recordedBy === "user") originalUpdate.notCopyOfFileIds = FieldValue.arrayRemove(copy.id);
  // The log (#752), on both Files.
  const markActor = recordedBy === "user" ? "manual" : "auto";
  Object.assign(originalUpdate, logActivity(activityEntry({
    type: "copy_marked",
    actor: markActor,
    fileId: copy.id,
    fileName: displayName(copy),
    summary: `"${displayName(copy)}" recorded as a Copy of this File`,
  }, now)));
  tx.update(original.ref, originalUpdate);

  const copyUpdate: Record<string, unknown> = {
    ...extraCopyUpdates,
    copyOfFileId: original.id,
    copyRecordedBy: recordedBy,
    copyRecordedAt: now,
    copySuggestion: null,
    // Never proposed as a Match: nothing for the queue to show.
    transactionSuggestions: [],
    transactionMatchComplete: true,
    transactionMatchedAt: now,
    updatedAt: now,
  };
  // A person marking the pair revokes an earlier "not a Copy" ruling.
  if (recordedBy === "user") copyUpdate.notCopyOfFileIds = FieldValue.arrayRemove(original.id);
  Object.assign(copyUpdate, logActivity(activityEntry({
    type: "copy_marked",
    actor: markActor,
    fileId: original.id,
    fileName: displayName(original),
    summary: `Recorded as a Copy of "${displayName(original)}"; its connections moved there`,
  }, now)));
  tx.update(copy.ref, copyUpdate);

  return { moved: move.moved, dropped: move.dropped, rematch: move.rematch };
}

/**
 * Follow a mark to the File at the end of the chain. A mark whose original is
 * no longer live ends the chain where it is.
 */
async function resolveRoot(
  tx: FirebaseFirestore.Transaction,
  db: Db,
  userId: string,
  start: Snap,
  stopAt: string
): Promise<Snap> {
  let current = start;
  const seen = new Set<string>([start.id]);
  for (let i = 0; i < 8; i++) {
    const next = current.data.copyOfFileId;
    if (typeof next !== "string" || !next || next === stopAt || seen.has(next)) return current;
    const ref = db.collection("files").doc(next);
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (!data || data.userId !== userId || !isLiveFile(data)) return current;
    current = { id: next, ref, data };
    seen.add(next);
  }
  return current;
}

export interface MarkCopyResult {
  success: true;
  fileId: string;
  /** The original the Copy points at: the root of the chain, which may differ from the id asked for. */
  originalFileId: string;
  /** Transactions whose File Connection moved from the Copy to the original. */
  movedConnections: string[];
  /** Transactions the Copy was taken off because the original already documents them. */
  removedConnections: string[];
}

/**
 * A person marks `fileId` as a Copy of `originalFileId`. Also how a Copy
 * suggestion is accepted. A FiBuKI-generated invoice is always the original,
 * so it is never marked.
 */
export async function markFileAsCopy(
  db: Db,
  userId: string,
  args: Record<string, unknown>,
  recordedBy: CopyRecordedBy = "user"
): Promise<MarkCopyResult> {
  const fileId = requireId(args.fileId, "fileId");
  const originalFileId = requireId(args.originalFileId, "originalFileId");
  if (fileId === originalFileId) {
    throw new HttpsError("invalid-argument", "A File cannot be a Copy of itself");
  }

  // Set by the attempt that commits; a retried attempt overwrites it.
  let rematch: Array<string | null> = [];
  const { result, reopenedExtraction } = await db.runTransaction(async (tx) => {
    const copy = await readOwnedFile(tx, db, userId, fileId);
    const named = await readOwnedFile(tx, db, userId, originalFileId);

    if (copy.data.deletedAt || named.data.deletedAt) {
      throw new HttpsError("failed-precondition", "A deleted File cannot be marked as a Copy or be an original. Restore it first.");
    }
    if (isGeneratedInvoiceFile(copy.data)) {
      throw new HttpsError(
        "failed-precondition",
        "COPY_OF_GENERATED_INVOICE: this File is the document FiBuKI generated for an invoice, which is always the original. Mark the other File as its Copy instead."
      );
    }

    // A Receipt and the invoice it pays are never a Copy of each other (#571).
    const linked = (a: Data, bId: string) => a.receiptLink?.fileId === bId;
    if (linked(copy.data, originalFileId) || linked(named.data, fileId)) {
      throw new HttpsError(
        "failed-precondition",
        "RECEIPT_LINK_NOT_COPY: these Files are a Receipt and the invoice it pays, which is never a Copy. Unlink them first."
      );
    }

    // The system never unlinks (ADR-0010). The Copy check saw the File
    // unconnected before this transaction; a connect that landed since is
    // seen here, and the record is refused rather than taking it apart.
    if (recordedBy === "system" && isConnectedFile(copy.data)) {
      throw new HttpsError("failed-precondition", "The File holds a File Connection; only a person may mark it");
    }

    const root = await resolveRoot(tx, db, userId, named, fileId);

    // A File hidden as "not an invoice" because it was a re-send becomes what
    // it is: an invoice document, recorded as a Copy. Clearing the mark
    // re-opens Extraction, which brings back the fields it cleared; it is
    // queued once the transaction has committed.
    const unmark = recordedBy === "user" && copy.data.isNotInvoice === true;
    // The un-mark re-extracts the File, which a Hand Correction refuses (#639).
    const unmarkRefused = unmark ? unmarkRefusal(copy.data) : null;
    if (unmarkRefused) {
      throw new HttpsError(
        "failed-precondition",
        `HAND_CORRECTED: ${unmarkRefused.message}`,
        unmarkRefused.details
      );
    }
    const extra = unmark ? buildUnmarkNotInvoiceUpdates(copy.data, false) : {};

    const applied = await applyCopy(tx, db, userId, copy, root, recordedBy, extra);
    rematch = applied.rematch;
    return {
      result: {
        success: true as const,
        fileId,
        originalFileId: root.id,
        movedConnections: applied.moved,
        removedConnections: applied.dropped,
      },
      reopenedExtraction: unmark,
    };
  });

  if (reopenedExtraction) await queueExtractionAfterUnmark(fileId, userId);
  await rematchRevertedTransactions(userId, rematch);
  return result;
}

export interface NotACopyResult {
  success: true;
  fileId: string;
  /** "undone": the File was a Copy and is not any more. "declined": a suggestion was turned down. */
  outcome: "undone" | "declined";
  /** The File the ruling names: never suggested as this File's original again. */
  notCopyOfFileId: string;
}

/**
 * "Not a Copy": undo a Copy, or decline a Copy suggestion. Either way the pair
 * gets a standing ruling on both Files, which survives re-extraction, so the
 * system neither suggests nor records it again. A person marking the pair
 * later revokes it.
 *
 * Undoing does not reconnect anything: the unlink a mark caused was never a
 * Rejection, and nothing is restored either. The File goes back to matching.
 */
export async function unmarkFileAsCopy(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<NotACopyResult> {
  const fileId = requireId(args.fileId, "fileId");

  return db.runTransaction(async (tx) => {
    const file = await readOwnedFile(tx, db, userId, fileId);
    const markedOf = typeof file.data.copyOfFileId === "string" ? file.data.copyOfFileId : null;
    const suggestedOf =
      typeof file.data.copySuggestion?.originalFileId === "string" ? file.data.copySuggestion.originalFileId : null;
    const otherId = markedOf ?? suggestedOf;
    if (!otherId) {
      throw new HttpsError("failed-precondition", "This File is not a Copy and has no Copy suggestion");
    }
    const otherRef = db.collection("files").doc(otherId);
    const otherSnap = await tx.get(otherRef);
    const other = otherSnap.exists ? otherSnap.data() : undefined;

    const now = Timestamp.now();
    tx.update(file.ref, {
      ...CLEARED_COPY_MARK,
      copySuggestion: null,
      notCopyOfFileIds: FieldValue.arrayUnion(otherId),
      ...(markedOf
        ? { transactionMatchComplete: false, transactionSuggestions: [] }
        : {}),
      updatedAt: now,
    });
    if (other && other.userId === userId && !other.purgedAt) {
      tx.update(otherRef, { notCopyOfFileIds: FieldValue.arrayUnion(fileId), updatedAt: now });
    }

    return {
      success: true as const,
      fileId,
      outcome: markedOf ? ("undone" as const) : ("declined" as const),
      notCopyOfFileId: otherId,
    };
  });
}

export interface MakeOriginalResult {
  success: true;
  /** The File that is now the original. */
  fileId: string;
  /** The former original, now a Copy of `fileId`. */
  copyFileId: string;
  movedConnections: string[];
}

/**
 * "Make this the original": the Copy `fileId` and its original swap places,
 * and the original's File Connections move to `fileId` in the same act.
 * Refused when the original is a FiBuKI-generated invoice, which is always
 * the original.
 */
export async function makeFileTheOriginal(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<MakeOriginalResult> {
  const fileId = requireId(args.fileId, "fileId");

  let rematch: Array<string | null> = [];
  const result = await db.runTransaction(async (tx) => {
    const file = await readOwnedFile(tx, db, userId, fileId);
    const originalId = typeof file.data.copyOfFileId === "string" ? file.data.copyOfFileId : null;
    if (!originalId) {
      throw new HttpsError("failed-precondition", "This File is not a Copy");
    }
    const original = await readOwnedFile(tx, db, userId, originalId);
    if (!isLiveFile(original.data) || file.data.deletedAt) {
      throw new HttpsError("failed-precondition", "This File is not a Copy while its original is deleted");
    }
    if (isGeneratedInvoiceFile(original.data)) {
      throw new HttpsError(
        "failed-precondition",
        "COPY_OF_GENERATED_INVOICE: the original is the document FiBuKI generated for an invoice, which is always the original."
      );
    }
    const applied = await applyCopy(tx, db, userId, original, file, "user");
    rematch = applied.rematch;
    return { success: true as const, fileId, copyFileId: originalId, movedConnections: applied.moved };
  });
  await rematchRevertedTransactions(userId, rematch);
  return result;
}

// ============================================================================
// The Copy check (system)
// ============================================================================

/** Generated-invoice numbers, read from the invoice records (ADR-0006). */
async function generatedNumber(db: Db, userId: string, data: Data): Promise<string | null> {
  if (!isGeneratedInvoiceFile(data) || typeof data.invoiceId !== "string") return null;
  const snap = await db.collection("invoices").doc(data.invoiceId).get();
  const inv = snap.exists ? snap.data() : undefined;
  return inv && inv.userId === userId && inv.number ? String(inv.number) : null;
}

export type CopyCheckOutcome =
  | { kind: "none" }
  /** The checked File was recorded as a Copy: it takes no part in matching. */
  | { kind: "recorded-this"; originalFileId: string }
  /** The other File was recorded as a Copy of the checked one. */
  | { kind: "recorded-other"; copyFileId: string }
  | { kind: "suggested"; copyFileId: string; originalFileId: string; reason: CopySuggestionReason };

/**
 * Runs after Extraction, before matching. Looks for another live File of the
 * same document, decides which of the two is the original, and then:
 *
 * - records the Copy when the evidence is exact and the Copy holds no File
 *   Connection (no File Connection is lost by it), or
 * - suggests it when marking would take a File Connection apart, or when an
 *   invoice number is missing on either side.
 *
 * Pairs a person ruled "not a Copy" are skipped. The system never unlinks.
 */
export async function runCopyCheck(
  db: Db,
  fileId: string,
  fileData: Data
): Promise<CopyCheckOutcome> {
  const userId = fileData.userId as string;
  if (!userId || !isLiveFile(fileData) || fileData.isNotInvoice === true) return { kind: "none" };
  if (typeof fileData.copyOfFileId === "string" && fileData.copyOfFileId) {
    const orig = await db.collection("files").doc(fileData.copyOfFileId).get();
    if (isLiveCopy(fileData, orig.exists ? orig.data() : undefined)) {
      return { kind: "recorded-this", originalFileId: fileData.copyOfFileId };
    }
  }

  const self = { id: fileId, data: fileData };
  const mine = copyEvidenceOf(fileData, await generatedNumber(db, userId, fileData));
  if (mine.amount === null || !mine.date || (!mine.vatId && !mine.issuerName)) return { kind: "none" };

  const candidatesSnap = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("extractedAmount", "==", mine.amount)
    .limit(200)
    .get();

  const candidates = candidatesSnap.docs
    .filter((doc) => doc.id !== fileId)
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter((c) => isLiveFile(c.data) && c.data.isNotInvoice !== true);
  // A Copy's original is the document; comparing against the Copy too would
  // only find the same original twice.
  const copies = await liveCopyIds(db, candidates);

  let best: { other: { id: string; data: Data }; verdict: "exact" | "no-invoice-number" } | null = null;
  for (const { id, data } of candidates) {
    if (copies.has(id)) continue;
    const other = { id, data };
    if (ruledNotCopy(self, other)) continue;
    // A Receipt and the invoice it pays are never a Copy (#571, ADR-0012).
    if (pairedForCopyCheck(self, other)) continue;
    const verdict = compareCopyEvidence(mine, copyEvidenceOf(data, await generatedNumber(db, userId, data)));
    if (!verdict) continue;
    if (!best || (verdict === "exact" && best.verdict !== "exact")) best = { other, verdict };
  }
  if (!best) {
    if (fileData.copySuggestion) {
      await db.collection("files").doc(fileId).update({ copySuggestion: null, updatedAt: Timestamp.now() });
    }
    return { kind: "none" };
  }

  const pick = pickOriginal(self, best.other);
  if (!pick) return { kind: "none" };
  const { original, copy } = pick;

  if (best.verdict === "exact" && !isConnectedFile(copy.data)) {
    try {
      await markFileAsCopy(db, userId, { fileId: copy.id, originalFileId: original.id }, "system");
    } catch (err) {
      // A concurrent change (a connect, a delete) made the record unsafe:
      // leave the pair to the next check rather than force it.
      console.warn(`[CopyCheck] Could not record ${copy.id} as a Copy of ${original.id}`, err);
      return { kind: "none" };
    }
    return copy.id === fileId
      ? { kind: "recorded-this", originalFileId: original.id }
      : { kind: "recorded-other", copyFileId: copy.id };
  }

  const reason: CopySuggestionReason = best.verdict === "exact" ? "connected" : "no-invoice-number";
  await suggestCopy(db, copy.id, original.id, reason);
  return { kind: "suggested", copyFileId: copy.id, originalFileId: original.id, reason };
}

/** Store a Copy suggestion on the would-be Copy. Never changes a File Connection. */
export async function suggestCopy(
  db: Db,
  copyFileId: string,
  originalFileId: string,
  reason: CopySuggestionReason
): Promise<void> {
  const ref = db.collection("files").doc(copyFileId);
  const already = ((await ref.get()).data()?.copySuggestion as { originalFileId?: string } | null)?.originalFileId === originalFileId;
  const originalName = (await db.collection("files").doc(originalFileId).get()).data()?.fileName ?? originalFileId;
  await ref.update({
    copySuggestion: { originalFileId, reason, suggestedAt: Timestamp.now() },
    updatedAt: Timestamp.now(),
    // The log (#752): once per suggested original, not on every re-check.
    ...(already ? {} : logActivity(activityEntry({
      type: "copy_suggested",
      actor: "auto",
      fileId: originalFileId,
      fileName: originalName,
      summary: `Looks like a Copy of "${originalName}"`,
    }))),
  });
}

// ============================================================================
// The one-time pass over Files from before the Copy check
// ============================================================================

export interface BackfillCopySuggestionsResult {
  success: true;
  /** Files sharing their bytes with an earlier File (stored before #182). */
  sameContent: number;
  /** Files hidden as "not an invoice" that name a live invoice File. */
  markedNotInvoice: number;
}

function normalizedFileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    // "invoice (1)", "invoice-copy": what a second download is named.
    .replace(/[\s_-]*(\(\d+\)|copy|kopie)$/, "")
    .replace(/[^a-z0-9]+/g, "");
  return n || null;
}

/**
 * Suggests Copies among the user's existing Files; records none. Two sets:
 *
 * - Files that share a `contentHash`: stored twice before #182 made identical
 *   bytes impossible to store again. The original is picked by the usual
 *   order among the invoices, the rest are suggested as its Copies. A group
 *   of Files all marked "not an invoice" is skipped: identical bytes do not
 *   make a non-document a Copy.
 * - Files marked "not an invoice", the workaround people used for a re-send.
 *   Marking cleared their extracted fields, so what is left to compare is the
 *   file name: suggested only when exactly one live invoice File carries the
 *   same name. Accepting one also clears the not-an-invoice mark.
 *
 * Skips Files that are already Copies, already carry a suggestion, or whose
 * pair a person ruled "not a Copy". Safe to run again.
 */
export async function backfillCopySuggestions(
  db: Db,
  userId: string
): Promise<BackfillCopySuggestionsResult> {
  const snap = await db.collection("files").where("userId", "==", userId).get();
  const all = snap.docs.map((d) => ({ id: d.id, data: d.data() })).filter((f) => isLiveFile(f.data));
  const copies = await liveCopyIds(db, all);
  const eligible = (f: { id: string; data: Data }) => !copies.has(f.id) && !f.data.copySuggestion;

  let sameContent = 0;
  const byHash = new Map<string, Array<{ id: string; data: Data }>>();
  for (const f of all) {
    if (copies.has(f.id) || typeof f.data.contentHash !== "string" || !f.data.contentHash) continue;
    const group = byHash.get(f.data.contentHash) ?? [];
    group.push(f);
    byHash.set(f.data.contentHash, group);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    // The original must be an invoice: two copies of a photo marked "not an
    // invoice" are still a photo, and accepting a suggestion lifts that mark.
    // A not-an-invoice member of a group that holds an invoice is the hidden
    // re-send this pass exists for.
    const invoices = group.filter((f) => f.data.isNotInvoice !== true);
    if (invoices.length === 0) continue;
    let original = invoices[0];
    for (const f of invoices.slice(1)) {
      const pick = pickOriginal(original, f);
      if (pick) original = pick.original;
    }
    for (const f of group) {
      if (f.id === original.id || !eligible(f) || ruledNotCopy(f, original)) continue;
      if (isGeneratedInvoiceFile(f.data)) continue;
      await suggestCopy(db, f.id, original.id, "same-content");
      f.data.copySuggestion = { originalFileId: original.id };
      sameContent++;
    }
  }

  let markedNotInvoice = 0;
  const invoicesByName = new Map<string, Array<{ id: string; data: Data }>>();
  for (const f of all) {
    if (f.data.isNotInvoice === true || copies.has(f.id)) continue;
    const key = normalizedFileName(f.data.fileName);
    if (!key) continue;
    const list = invoicesByName.get(key) ?? [];
    list.push(f);
    invoicesByName.set(key, list);
  }
  for (const f of all) {
    if (f.data.isNotInvoice !== true || !eligible(f)) continue;
    const key = normalizedFileName(f.data.fileName);
    const matches = key ? invoicesByName.get(key) ?? [] : [];
    if (matches.length !== 1 || ruledNotCopy(f, matches[0])) continue;
    await suggestCopy(db, f.id, matches[0].id, "marked-not-invoice");
    markedNotInvoice++;
  }

  return { success: true, sameContent, markedNotInvoice };
}
