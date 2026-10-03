/**
 * The correction link's state transitions (#564, ADR-0010), shared by the
 * callables behind the UI and the MCP tools, so an AI client cannot leave a
 * correction in a state the UI would refuse.
 *
 *  - runCorrectionCheck   after Extraction: classify the File (D8), and link it
 *                         when the referenced number matches, else suggest
 *  - linkCorrection       a person links (or accepts a suggestion)
 *  - unlinkCorrection     a person unlinks, or declines a suggestion; the pair
 *                         is never linked automatically again
 *  - getCorrection        what a File corrects and who paid it, or what a
 *                         Transaction is related to through a correction
 *  - backfillCorrectionLinks  the one-time pass over existing credit notes
 *
 * Every id a caller names must be the user's own; a foreign id answers like a
 * missing one.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import { classifyCorrectionDocument } from "./classifyCorrectionDocument";
import { matchCorrectionLink, type LinkMatchCandidate } from "./linkMatcher";
import type { CorrectionLinkSetBy } from "./resolveCorrections";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;

/** The candidate Files read per correction, at most. */
const CANDIDATE_LIMIT = 500;

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpsError("invalid-argument", `${name} is required`);
  }
  return value;
}

function isLive(data: Data | undefined): data is Data {
  return !!data && !data.deletedAt && !data.purgedAt;
}

async function readOwned(
  db: Db,
  collection: "files" | "transactions",
  userId: string,
  id: string
): Promise<{ id: string; data: Data }> {
  const snap = await db.collection(collection).doc(id).get();
  const data = snap.exists ? snap.data() : undefined;
  if (!data || data.userId !== userId || data.purgedAt) {
    throw new HttpsError("not-found", collection === "files" ? "File not found" : "Transaction not found");
  }
  return { id, data };
}

function dayOf(value: unknown): string | null {
  const d = toDateSafe(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

function isCorrectionDocument(data: Data): boolean {
  return !!data.correctionLink?.fileId || classifyCorrectionDocument(data).kind === "invoice-correction";
}

// ============================================================================
// After Extraction
// ============================================================================

export type CorrectionCheckOutcome =
  | { kind: "not-a-correction" }
  | { kind: "kept"; originalFileId: string }
  | { kind: "linked"; originalFileId: string }
  | { kind: "suggested"; fileIds: string[] }
  | { kind: "none" };

/**
 * Classify the File and, when it reads as an Invoice Correction, find its
 * original. A link a person set or accepted is never touched; an automatic
 * one is re-derived, so a corrected referenced number moves it.
 */
export async function runCorrectionCheck(db: Db, fileId: string, fileData: Data): Promise<CorrectionCheckOutcome> {
  const userId = fileData.userId as string;
  if (!userId || !isLive(fileData)) return { kind: "none" };
  const ref = db.collection("files").doc(fileId);
  const verdict = classifyCorrectionDocument(fileData);
  const classification = {
    correctionKind: verdict.kind,
    correctionSignalsDisagree: verdict.signalsDisagree,
  };

  const link = fileData.correctionLink as { fileId?: string; setBy?: CorrectionLinkSetBy } | null | undefined;
  const classified =
    (fileData.correctionKind ?? null) === verdict.kind &&
    (fileData.correctionSignalsDisagree ?? false) === verdict.signalsDisagree;
  if (link?.fileId && link.setBy !== "auto") {
    if (!classified) await ref.update({ ...classification, updatedAt: Timestamp.now() });
    return { kind: "kept", originalFileId: link.fileId };
  }
  if (verdict.kind !== "invoice-correction") {
    // Most Files are no correction at all: write only what changed, so the
    // backfill over every File stays a read for them.
    if (classified && !link?.fileId && !(fileData.correctionSuggestions ?? []).length) {
      return { kind: "not-a-correction" };
    }
    await ref.update({
      ...classification,
      ...(link?.fileId ? { correctionLink: null } : {}),
      correctionSuggestions: [],
      updatedAt: Timestamp.now(),
    });
    return { kind: "not-a-correction" };
  }

  const candidates = await candidateFiles(db, userId, fileData.partnerId);
  const result = matchCorrectionLink(
    {
      id: fileId,
      userId,
      partnerId: fileData.partnerId ?? null,
      referencedInvoiceNumber: fileData.extractedReferencedInvoiceNumber ?? null,
      amount: fileData.extractedAmount ?? null,
      date: dayOf(fileData.extractedDate),
      declinedFileIds: fileData.correctionDeclinedFileIds ?? [],
    },
    candidates
  );

  const now = Timestamp.now();
  if (result.kind === "link") {
    await ref.update({
      ...classification,
      correctionLink: { fileId: result.fileId, setBy: "auto", setAt: now },
      correctionSuggestions: [],
      updatedAt: now,
    });
    return { kind: "linked", originalFileId: result.fileId };
  }
  await ref.update({
    ...classification,
    ...(link?.fileId ? { correctionLink: null } : {}),
    correctionSuggestions:
      result.kind === "suggestions" ? result.fileIds.map((id) => ({ fileId: id, suggestedAt: now })) : [],
    updatedAt: now,
  });
  return result.kind === "suggestions" ? { kind: "suggested", fileIds: result.fileIds } : { kind: "none" };
}

/** The user's live Files of one Partner that could be an original: no Copies, no non-invoices. */
async function candidateDocs(db: Db, userId: string, partnerId: unknown): Promise<Array<{ id: string; data: Data }>> {
  if (typeof partnerId !== "string" || !partnerId) return [];
  const snap = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .limit(CANDIDATE_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter((f) => isLive(f.data) && f.data.isNotInvoice !== true && !f.data.copyOfFileId);
}

function fileRef(id: string, data: Data): CorrectionFileRef {
  return {
    fileId: id,
    fileName: data.fileName ?? null,
    invoiceNumber: data.extractedInvoiceNumber ?? null,
    amount: data.extractedAmount ?? null,
    date: dayOf(data.extractedDate),
  };
}

/** The original File behind an Invoice Correction FiBuKI issued, through its Invoice. */
async function issuedOriginalFileId(db: Db, userId: string, invoiceId: unknown): Promise<string | null> {
  if (typeof invoiceId !== "string" || !invoiceId) return null;
  const inv = await db.collection("invoices").doc(invoiceId).get();
  const correctsId = inv.exists && inv.data()?.userId === userId ? inv.data()?.correctsInvoice?.invoiceId : null;
  if (!correctsId) return null;
  const original = await db.collection("invoices").doc(correctsId).get();
  const data = original.exists ? original.data() : null;
  return data && data.userId === userId && typeof data.fileId === "string" ? data.fileId : null;
}

async function candidateFiles(db: Db, userId: string, partnerId: unknown): Promise<LinkMatchCandidate[]> {
  return (await candidateDocs(db, userId, partnerId))
    .map((f) => ({
      id: f.id,
      userId: f.data.userId,
      partnerId: f.data.partnerId ?? null,
      invoiceNumber: f.data.extractedInvoiceNumber ?? null,
      amount: f.data.extractedAmount ?? null,
      date: dayOf(f.data.extractedDate),
      isCorrection: isCorrectionDocument(f.data),
    }));
}

// ============================================================================
// A person's acts
// ============================================================================

export interface LinkCorrectionResult {
  success: true;
  fileId: string;
  originalFileId: string;
  setBy: CorrectionLinkSetBy;
}

/**
 * Link a correction File to the File it corrects. Linking one of the File's
 * own suggestions records it as accepted rather than typed in.
 */
export async function linkCorrection(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<LinkCorrectionResult> {
  const fileId = requireId(args.fileId, "fileId");
  const originalFileId = requireId(args.originalFileId, "originalFileId");
  if (fileId === originalFileId) {
    throw new HttpsError("invalid-argument", "A File cannot correct itself");
  }
  const file = await readOwned(db, "files", userId, fileId);
  const original = await readOwned(db, "files", userId, originalFileId);
  if (!isLive(file.data) || !isLive(original.data)) {
    throw new HttpsError("failed-precondition", "A deleted File cannot be linked. Restore it first.");
  }
  if (original.data.correctionLink?.fileId) {
    throw new HttpsError(
      "failed-precondition",
      "That File is itself a correction of another File. Link this one to the original invoice instead."
    );
  }

  const suggested = ((file.data.correctionSuggestions ?? []) as Array<{ fileId: string }>).some(
    (s) => s.fileId === originalFileId
  );
  const setBy: CorrectionLinkSetBy = suggested ? "suggested-accepted" : "manual";
  const now = Timestamp.now();
  await db.collection("files").doc(fileId).update({
    correctionLink: { fileId: originalFileId, setBy, setAt: now },
    correctionSuggestions: [],
    correctionDeclinedFileIds: FieldValue.arrayRemove(originalFileId),
    updatedAt: now,
  });
  return { success: true, fileId, originalFileId, setBy };
}

export interface UnlinkCorrectionResult {
  success: true;
  fileId: string;
  /** "unlinked": the link was removed. "declined": a suggestion was turned down. */
  outcome: "unlinked" | "declined";
  /** The File never linked to this correction automatically again. */
  declinedFileId: string;
}

/**
 * Remove a correction's link, or decline one of its suggestions
 * (`originalFileId`). The File it named is recorded as declined, so the
 * automatic link never sets it again; linking the pair by hand revokes that.
 */
export async function unlinkCorrection(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<UnlinkCorrectionResult> {
  const fileId = requireId(args.fileId, "fileId");
  const file = await readOwned(db, "files", userId, fileId);
  const linkedTo = (file.data.correctionLink?.fileId as string | undefined) ?? null;
  const named = typeof args.originalFileId === "string" && args.originalFileId ? args.originalFileId : null;
  const suggestions = (file.data.correctionSuggestions ?? []) as Array<{ fileId: string }>;

  const now = Timestamp.now();
  if (linkedTo && (!named || named === linkedTo)) {
    await db.collection("files").doc(fileId).update({
      correctionLink: null,
      correctionDeclinedFileIds: FieldValue.arrayUnion(linkedTo),
      updatedAt: now,
    });
    return { success: true, fileId, outcome: "unlinked", declinedFileId: linkedTo };
  }
  if (named && suggestions.some((s) => s.fileId === named)) {
    await db.collection("files").doc(fileId).update({
      correctionSuggestions: suggestions.filter((s) => s.fileId !== named),
      correctionDeclinedFileIds: FieldValue.arrayUnion(named),
      updatedAt: now,
    });
    return { success: true, fileId, outcome: "declined", declinedFileId: named };
  }
  throw new HttpsError("failed-precondition", "This File has no correction link or suggestion to remove");
}

// ============================================================================
// Inspecting
// ============================================================================

export interface CorrectionTransactionRef {
  id: string;
  date: string | null;
  amount: number;
  partner: string | null;
}

export interface CorrectionFileRef {
  fileId: string;
  fileName: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  date: string | null;
}

/** Files of the same Partner offered for a manual link, at most. */
const MANUAL_CANDIDATES = 20;

export interface CorrectionFileView {
  fileId: string;
  /** D8: what the document reads as, and whether its signals disagree. */
  kind: "invoice-correction" | "self-billed-invoice" | null;
  signalsDisagree: boolean;
  referencedInvoiceNumber: string | null;
  /**
   * The link to the original. `issued-correction`: an Invoice Correction
   * FiBuKI issued, which names its original Invoice; it cannot be unlinked.
   */
  link: { originalFileId: string; setBy: CorrectionLinkSetBy | "issued-correction" } | null;
  original: {
    fileId: string;
    fileName: string | null;
    invoiceNumber: string | null;
    amount: number | null;
    /** The Transactions that paid the original. */
    paidBy: CorrectionTransactionRef[];
  } | null;
  suggestions: CorrectionFileRef[];
  /** Files of the same Partner a person may link by hand, newest first. */
  candidates: CorrectionFileRef[];
  /** Corrections linked to this File, when it is an original. */
  correctedBy: Array<{ fileId: string; fileName: string | null; transactions: CorrectionTransactionRef[] }>;
}

export interface CorrectionTransactionView {
  transactionId: string;
  /** Transactions related through a correction, and which way. */
  related: Array<CorrectionTransactionRef & { relation: "refund-of" | "refunded-by"; viaFileId: string }>;
}

export async function getCorrection(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<CorrectionFileView | CorrectionTransactionView> {
  if (typeof args.transactionId === "string" && args.transactionId) {
    return correctionViewOfTransaction(db, userId, args.transactionId);
  }
  const fileId = requireId(args.fileId, "fileId");
  return correctionViewOfFile(db, userId, fileId);
}

async function correctionViewOfFile(db: Db, userId: string, fileId: string): Promise<CorrectionFileView> {
  const file = await readOwned(db, "files", userId, fileId);
  const verdict = classifyCorrectionDocument(file.data);
  const stored = file.data.correctionLink as { fileId: string; setBy: CorrectionLinkSetBy } | null | undefined;
  const issued = stored?.fileId ? null : await issuedOriginalFileId(db, userId, file.data.invoiceId);
  const link: CorrectionFileView["link"] = stored?.fileId
    ? { originalFileId: stored.fileId, setBy: stored.setBy }
    : issued
      ? { originalFileId: issued, setBy: "issued-correction" }
      : null;

  let original: CorrectionFileView["original"] = null;
  if (link) {
    const o = await readOwnedOrNull(db, "files", userId, link.originalFileId);
    if (o) {
      original = {
        fileId: o.id,
        fileName: o.data.fileName ?? null,
        invoiceNumber: o.data.extractedInvoiceNumber ?? null,
        amount: o.data.extractedAmount ?? null,
        paidBy: (await ownTransactions(db, userId, o.data.transactionIds ?? [])).filter(
          (t) => !file.data.transactionIds?.includes(t.id)
        ),
      };
    }
  }

  const suggestions: CorrectionFileRef[] = [];
  for (const s of (file.data.correctionSuggestions ?? []) as Array<{ fileId: string }>) {
    const f = await readOwnedOrNull(db, "files", userId, s.fileId);
    if (f && isLive(f.data)) suggestions.push(fileRef(f.id, f.data));
  }

  // Only a correction is offered originals to link by hand.
  const candidates: CorrectionFileRef[] =
    verdict.kind === "invoice-correction" || link
      ? (await candidateDocs(db, userId, file.data.partnerId))
          .filter((c) => c.id !== fileId && !isCorrectionDocument(c.data))
          .sort((a, b) => (dayOf(b.data.extractedDate) ?? "").localeCompare(dayOf(a.data.extractedDate) ?? ""))
          .slice(0, MANUAL_CANDIDATES)
          .map((c) => fileRef(c.id, c.data))
      : [];

  const linkedSnap = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("correctionLink.fileId", "==", fileId)
    .get();
  const correctedBy: CorrectionFileView["correctedBy"] = [];
  for (const doc of linkedSnap.docs) {
    const d = doc.data();
    if (!isLive(d)) continue;
    correctedBy.push({
      fileId: doc.id,
      fileName: d.fileName ?? null,
      transactions: await ownTransactions(db, userId, d.transactionIds ?? []),
    });
  }

  return {
    fileId,
    kind: verdict.kind,
    signalsDisagree: verdict.signalsDisagree,
    referencedInvoiceNumber: file.data.extractedReferencedInvoiceNumber ?? null,
    link,
    original,
    suggestions,
    candidates,
    correctedBy,
  };
}

/**
 * What a Transaction is related to through a correction (story 18): a refund
 * leads to the Transactions that paid its original, and a purchase or sale to
 * the refunds of it.
 */
async function correctionViewOfTransaction(
  db: Db,
  userId: string,
  transactionId: string
): Promise<CorrectionTransactionView> {
  const tx = await readOwned(db, "transactions", userId, transactionId);
  const sign = Math.sign(tx.data.amount ?? 0);
  const related: CorrectionTransactionView["related"] = [];
  const seen = new Set<string>([transactionId]);
  const push = (t: CorrectionTransactionRef, relation: "refund-of" | "refunded-by", viaFileId: string) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    related.push({ ...t, relation, viaFileId });
  };

  for (const fid of (tx.data.fileIds ?? []) as string[]) {
    const f = await readOwnedOrNull(db, "files", userId, fid);
    if (!f) continue;
    // This line carries a correction: its original's payers.
    const originalId = f.data.correctionLink?.fileId as string | undefined;
    if (originalId) {
      const o = await readOwnedOrNull(db, "files", userId, originalId);
      for (const t of await ownTransactions(db, userId, o?.data.transactionIds ?? [])) {
        if (Math.sign(t.amount) === -sign) push(t, "refund-of", originalId);
      }
      continue;
    }
    // The File sits on both sides of the bank (D9): the other side is related.
    for (const t of await ownTransactions(db, userId, f.data.transactionIds ?? [])) {
      if (Math.sign(t.amount) !== -sign || t.id === transactionId) continue;
      const earlier = (t.date ?? "") <= (dayOf(tx.data.date) ?? "");
      push(t, earlier ? "refund-of" : "refunded-by", fid);
    }
    // This line paid an original: the refunds through its corrections.
    const linked = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("correctionLink.fileId", "==", fid)
      .get();
    for (const doc of linked.docs) {
      for (const t of await ownTransactions(db, userId, doc.data().transactionIds ?? [])) {
        push(t, "refunded-by", doc.id);
      }
    }
  }
  return { transactionId, related };
}

async function readOwnedOrNull(
  db: Db,
  collection: "files" | "transactions",
  userId: string,
  id: string
): Promise<{ id: string; data: Data } | null> {
  try {
    return await readOwned(db, collection, userId, id);
  } catch {
    return null;
  }
}

async function ownTransactions(db: Db, userId: string, ids: string[]): Promise<CorrectionTransactionRef[]> {
  const out: CorrectionTransactionRef[] = [];
  for (const id of ids) {
    const t = await readOwnedOrNull(db, "transactions", userId, id);
    if (!t) continue;
    out.push({
      id: t.id,
      date: dayOf(t.data.date),
      amount: t.data.amount ?? 0,
      partner: t.data.partner ?? t.data.name ?? null,
    });
  }
  return out;
}

// ============================================================================
// The one-time pass over existing credit notes
// ============================================================================

export interface BackfillCorrectionLinksResult {
  success: true;
  /** Files read as Invoice Corrections. */
  corrections: number;
  linked: number;
  suggested: number;
}

/**
 * Runs the correction check over every live File of the user (story 47).
 * Links what the referenced number settles and suggests the rest; a link a
 * person set or accepted is kept. Safe to run again.
 */
export async function backfillCorrectionLinks(db: Db, userId: string): Promise<BackfillCorrectionLinksResult> {
  const snap = await db.collection("files").where("userId", "==", userId).get();
  let corrections = 0;
  let linked = 0;
  let suggested = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!isLive(data) || data.isNotInvoice === true) continue;
    const outcome = await runCorrectionCheck(db, doc.id, data);
    if (outcome.kind === "not-a-correction" || outcome.kind === "none") {
      if (outcome.kind === "none" && isCorrectionDocument(data)) corrections++;
      continue;
    }
    corrections++;
    if (outcome.kind === "linked" || outcome.kind === "kept") linked++;
    if (outcome.kind === "suggested") suggested++;
  }
  return { success: true, corrections, linked, suggested };
}
