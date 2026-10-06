/**
 * The Receipt Link's state transitions (#571, ADR-0012), shared by the
 * callables behind the UI, the chat assistant and the MCP tools, so an AI
 * client cannot leave a pair in a state the UI would refuse.
 *
 *  - runReceiptPairCheck  after Extraction: record the link a cited invoice
 *                         number settles, suggest the pairs Partner, day and
 *                         amount point at
 *  - linkReceipt          a person links (or accepts a suggestion)
 *  - unlinkReceipt        a person unlinks, or declines a suggestion; the
 *                         pair is never linked or suggested again
 *  - getReceiptLink       a File's invoice or Receipts, and its suggestions
 *  - backfillReceiptPairs the one-time suggestion pass over stored Files
 *
 * Recording or accepting a link connects the other File to the Transaction
 * the first one is on (rule 6); the File Connection writer does the same on
 * every later connect of either File. Nothing here moves a File Connection.
 *
 * Every id a caller names must be the user's own; a foreign id answers like a
 * missing one.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import { copyEvidenceOf, isLiveCopy, liveCopyIds } from "../files/copyOps";
import { filePaymentTotal } from "../matching/coverage";
import { connectFiles } from "../fileConnections/writer";
import { matchReceiptPair, suggestedReceipt, type PairLink, type PairMatchFile } from "./pairMatcher";
import { normalizeInvoiceNumber } from "../corrections/linkMatcher";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;

export type ReceiptLinkSetBy = "auto" | "suggested-accepted" | "manual";

/** The candidate Files read per query, at most. */
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

async function readOwnedOrNull(db: Db, userId: string, id: string): Promise<{ id: string; data: Data } | null> {
  try {
    return await readOwned(db, "files", userId, id);
  } catch {
    return null;
  }
}

function dayOf(value: unknown): string | null {
  const d = toDateSafe(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

function linkOf(data: Data): { fileId: string; setBy: ReceiptLinkSetBy } | null {
  const link = data.receiptLink as { fileId?: string; setBy?: ReceiptLinkSetBy } | null | undefined;
  return link?.fileId ? { fileId: link.fileId, setBy: link.setBy ?? "auto" } : null;
}

function suggestionIds(data: Data): string[] {
  const list = Array.isArray(data.receiptPairSuggestions) ? data.receiptPairSuggestions : [];
  return list.map((s: { fileId?: string }) => s?.fileId).filter((id: unknown): id is string => typeof id === "string");
}

function declinedIds(data: Data): string[] {
  return Array.isArray(data.receiptPairDeclinedFileIds) ? data.receiptPairDeclinedFileIds : [];
}

function transactionIdsOf(data: Data): string[] {
  return Array.isArray(data.transactionIds) ? data.transactionIds : [];
}

/** Name `otherId` among `id`'s pairing suggestions, once. */
async function addSuggestion(db: Db, userId: string, id: string, otherId: string, now: Timestamp): Promise<void> {
  const file = await readOwnedOrNull(db, userId, id);
  if (!file || suggestionIds(file.data).includes(otherId)) return;
  await db.collection("files").doc(id).update({
    receiptPairSuggestions: [...(file.data.receiptPairSuggestions ?? []), { fileId: otherId, suggestedAt: now }],
    updatedAt: now,
  });
}

/** Take `otherId` off `id`'s pairing suggestions. */
async function dropSuggestion(db: Db, userId: string, id: string, otherId: string, now: Timestamp): Promise<void> {
  const file = await readOwnedOrNull(db, userId, id);
  if (!file || !suggestionIds(file.data).includes(otherId)) return;
  await db.collection("files").doc(id).update({
    receiptPairSuggestions: (file.data.receiptPairSuggestions as Array<{ fileId: string }>).filter(
      (s) => s?.fileId !== otherId
    ),
    updatedAt: now,
  });
}

/** The pair as the pure matcher reads it. */
function pairFile(id: string, data: Data, liveCopy: boolean, generatedNumber?: string | null): PairMatchFile {
  const evidence = copyEvidenceOf(data);
  const recipient = data.extractedRecipient as { name?: string | null; vatId?: string | null } | null | undefined;
  const recipientEvidence = copyEvidenceOf({ extractedIssuer: recipient ?? null });
  return {
    id,
    userId: data.userId,
    partnerId: data.partnerId ?? null,
    issuerVatId: evidence.vatId,
    issuerName: evidence.issuerName,
    outgoing: data.invoiceDirection === "outgoing",
    recipientVatId: recipientEvidence.vatId,
    recipientName: recipientEvidence.issuerName,
    // A FiBuKI-generated invoice's number lives on its Invoice (ADR-0006).
    invoiceNumber: generatedNumber ?? data.extractedInvoiceNumber ?? null,
    paidInvoiceNumber: data.extractedPaidInvoiceNumber ?? null,
    payment: filePaymentTotal(data.extractedAmount, data.extractedTipAmount),
    currency: data.extractedCurrency ?? null,
    day: dayOf(data.extractedDate),
    documentType: data.documentType ?? null,
    receiptOfFileId: linkOf(data)?.fileId ?? null,
    isLiveCopy: liveCopy,
    declinedFileIds: declinedIds(data),
    copySuggestionWith: data.copySuggestion?.originalFileId ?? null,
  };
}

/**
 * Both Files are connected, to Transactions they do not share: linking them
 * would ask a File Connection to move, which needs a person (rule 6). Such a
 * pair is only suggested.
 */
function connectedApart(a: Data, b: Data): boolean {
  const aTx = transactionIdsOf(a);
  const bTx = transactionIdsOf(b);
  return aTx.length > 0 && bTx.length > 0 && !aTx.some((t) => bTx.includes(t));
}

/** The user's live Files that could pair with this one. */
async function candidateDocs(db: Db, userId: string, data: Data): Promise<Array<{ id: string; data: Data }>> {
  const byId = new Map<string, Data>();
  const add = (snap: FirebaseFirestore.QuerySnapshot) => {
    for (const d of snap.docs) byId.set(d.id, d.data());
  };
  const files = db.collection("files").where("userId", "==", userId);
  if (typeof data.partnerId === "string" && data.partnerId) {
    add(await files.where("partnerId", "==", data.partnerId).limit(CANDIDATE_LIMIT).get());
  }
  // The number keys reach across Partners: the issuer, not the Partner,
  // decides whether a cited number is this invoice's.
  if (typeof data.extractedPaidInvoiceNumber === "string" && data.extractedPaidInvoiceNumber) {
    add(await files.where("extractedInvoiceNumber", "==", data.extractedPaidInvoiceNumber).limit(CANDIDATE_LIMIT).get());
    // An Invoice the User issued in FiBuKI carries its number on the Invoice.
    const issued = await db
      .collection("invoices")
      .where("userId", "==", userId)
      .where("number", "==", data.extractedPaidInvoiceNumber)
      .limit(CANDIDATE_LIMIT)
      .get();
    const issuedFileIds = issued.docs
      .map((d) => d.data().fileId)
      .filter((id): id is string => typeof id === "string" && !!id);
    if (issuedFileIds.length > 0) {
      const snaps = await db.getAll(...issuedFileIds.map((id) => db.collection("files").doc(id)));
      for (const snap of snaps) {
        const d = snap.exists ? snap.data() : undefined;
        if (d && d.userId === userId) byId.set(snap.id, d);
      }
    }
  }
  if (typeof data.extractedInvoiceNumber === "string" && data.extractedInvoiceNumber) {
    add(await files.where("extractedPaidInvoiceNumber", "==", data.extractedInvoiceNumber).limit(CANDIDATE_LIMIT).get());
  }
  return [...byId]
    .map(([id, d]) => ({ id, data: d }))
    .filter((f) => isLive(f.data) && f.data.isNotInvoice !== true);
}

/** The numbers of the FiBuKI-generated invoices among these Files, read off their Invoices. */
async function generatedNumbers(
  db: Db,
  userId: string,
  files: Array<{ id: string; data: Data }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const generated = files.filter((f) => f.data.isFibukiGenerated === true && typeof f.data.invoiceId === "string" && f.data.invoiceId);
  if (generated.length === 0) return out;
  const snaps = await db.getAll(...generated.map((f) => db.collection("invoices").doc(f.data.invoiceId)));
  snaps.forEach((snap, i) => {
    const inv = snap.exists ? snap.data() : undefined;
    if (inv && inv.userId === userId && inv.number) out.set(generated[i].id, String(inv.number));
  });
  return out;
}

async function isLiveCopyFile(db: Db, data: Data): Promise<boolean> {
  if (typeof data.copyOfFileId !== "string" || !data.copyOfFileId) return false;
  const orig = await db.collection("files").doc(data.copyOfFileId).get();
  return isLiveCopy(data, orig.exists ? orig.data() : undefined);
}

// ============================================================================
// Following the pair
// ============================================================================

/**
 * When one File of a linked pair sits on exactly one Transaction and the
 * other on none, connect the other there (rule 6): origin `auto`, reason
 * `paired`. A File already connected anywhere is never moved, and a File on
 * several Transactions names no one Transaction to follow.
 */
export async function followReceiptLink(db: Db, userId: string, link: PairLink): Promise<string | null> {
  const receipt = await readOwnedOrNull(db, userId, link.receiptId);
  const invoice = await readOwnedOrNull(db, userId, link.invoiceId);
  if (!receipt || !invoice || !isLive(receipt.data) || !isLive(invoice.data)) return null;
  const rTx = transactionIdsOf(receipt.data);
  const iTx = transactionIdsOf(invoice.data);
  let pair: { fileId: string; transactionId: string } | null = null;
  if (rTx.length === 1 && iTx.length === 0) pair = { fileId: invoice.id, transactionId: rTx[0] };
  if (iTx.length === 1 && rTx.length === 0) pair = { fileId: receipt.id, transactionId: iTx[0] };
  if (!pair) return null;
  const [outcome] = await connectFiles(db, userId, [{ ...pair, autoConnectReason: "paired" }], { origin: "auto" });
  return outcome.status === "connected" ? pair.fileId : null;
}

// ============================================================================
// After Extraction
// ============================================================================

export interface ReceiptPairCheckOutcome {
  /** Links recorded by this run. */
  linked: PairLink[];
  /** Files suggested as this File's pair. */
  suggested: string[];
  /** A link a person set or accepted, left standing. */
  kept: boolean;
  /** Files the follow connected, this one included when it was connected. */
  connectedFileIds: string[];
}

export interface ReceiptPairCheckOptions {
  /**
   * Suggest only, never record a link and so never connect: the one-time pass
   * over stored Files, and the check after a Hand Correction (#638).
   */
  suggestOnly?: boolean;
}

/**
 * Record the links a cited invoice number settles, from either side, and
 * suggest the pairs Partner, day and amount point at. A link a person set or
 * accepted is never touched; an automatic one is re-decided, so a
 * re-extracted number moves it.
 */
export async function runReceiptPairCheck(
  db: Db,
  fileId: string,
  fileData: Data,
  options: ReceiptPairCheckOptions = {}
): Promise<ReceiptPairCheckOutcome> {
  const outcome: ReceiptPairCheckOutcome = { linked: [], suggested: [], kept: false, connectedFileIds: [] };
  const userId = fileData.userId as string;
  if (!userId || !isLive(fileData) || fileData.isNotInvoice === true) return outcome;
  const ref = db.collection("files").doc(fileId);
  const stored = linkOf(fileData);
  if (stored && stored.setBy !== "auto") {
    outcome.kept = true;
    return outcome;
  }
  if (await isLiveCopyFile(db, fileData)) return outcome;

  const docs = await candidateDocs(db, userId, fileData);
  const copies = await liveCopyIds(db, docs);
  const numbers = await generatedNumbers(db, userId, [{ id: fileId, data: fileData }, ...docs]);
  const self = pairFile(
    fileId,
    { ...fileData, receiptLink: options.suggestOnly ? fileData.receiptLink : null },
    false,
    numbers.get(fileId)
  );
  const result = matchReceiptPair(
    self,
    docs.filter((d) => d.id !== fileId).map((d) => pairFile(d.id, d.data, copies.has(d.id), numbers.get(d.id)))
  );
  const dataOf = new Map(docs.map((d) => [d.id, d.data]));
  dataOf.set(fileId, fileData);

  const now = Timestamp.now();
  const toRecord: PairLink[] = [];
  const demoted: string[] = [];
  for (const link of result.links) {
    const other = link.receiptId === fileId ? link.invoiceId : link.receiptId;
    if (options.suggestOnly || connectedApart(fileData, dataOf.get(other) ?? {})) demoted.push(other);
    else toRecord.push(link);
  }

  // This File's own link, re-decided.
  const mine = toRecord.find((l) => l.receiptId === fileId);
  const update: Record<string, unknown> = {};
  if (!options.suggestOnly) {
    if (mine) {
      if (stored?.fileId !== mine.invoiceId) update.receiptLink = { fileId: mine.invoiceId, setBy: "auto", setAt: now };
    } else if (stored) {
      update.receiptLink = null;
    }
  }
  const suggestions = [...new Set([...demoted, ...(mine ? [] : result.suggestions)])].filter(
    (id) => !(options.suggestOnly && stored?.fileId === id)
  );
  const before = suggestionIds(fileData);
  if (mine) update.receiptPairSuggestions = [];
  else if (suggestions.join() !== before.join()) {
    update.receiptPairSuggestions = suggestions.map((id) => ({ fileId: id, suggestedAt: now }));
  }
  if (Object.keys(update).length > 0) await ref.update({ ...update, updatedAt: now });

  // The other side of each pair: its link, and no suggestions left on it (a
  // Receipt pays one invoice).
  for (const link of toRecord) {
    if (link.receiptId === fileId) continue;
    const receiptData = dataOf.get(link.receiptId) ?? {};
    await db.collection("files").doc(link.receiptId).update({
      receiptLink: { fileId, setBy: "auto", setAt: now },
      receiptPairSuggestions: [],
      updatedAt: now,
    });
    for (const id of suggestionIds(receiptData)) {
      if (id !== fileId) await dropSuggestion(db, userId, id, link.receiptId, now);
    }
  }
  const suggestedNow = mine ? [] : suggestions;
  for (const id of suggestedNow) await addSuggestion(db, userId, id, fileId, now);
  for (const id of before.filter((b) => !suggestedNow.includes(b))) {
    await dropSuggestion(db, userId, id, fileId, now);
  }

  const fresh = toRecord.filter(
    (l) => !(l.receiptId === fileId && stored?.fileId === l.invoiceId)
  );
  for (const link of fresh) {
    const connected = await followReceiptLink(db, userId, link).catch((err) => {
      console.error(`[ReceiptPair] Following ${link.receiptId} -> ${link.invoiceId} failed`, err);
      return null;
    });
    if (connected) outcome.connectedFileIds.push(connected);
  }
  // Receipts the system linked to this File on a number it no longer
  // carries are re-decided too: a re-extracted invoice number moves them.
  if (!options.suggestOnly) {
    const own = normalizeInvoiceNumber(self.invoiceNumber);
    const linkedHere = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("receiptLink.fileId", "==", fileId)
      .get();
    for (const doc of linkedHere.docs) {
      const d = doc.data();
      if (linkOf(d)?.setBy !== "auto" || normalizeInvoiceNumber(d.extractedPaidInvoiceNumber) === own) continue;
      await runReceiptPairCheck(db, doc.id, d).catch((err) => {
        console.error(`[ReceiptPair] Re-deciding ${doc.id} failed`, err);
      });
    }
  }

  outcome.linked = toRecord;
  outcome.suggested = suggestedNow;
  return outcome;
}

// ============================================================================
// A person's acts
// ============================================================================

export interface LinkReceiptResult {
  success: true;
  /** The Receipt. */
  fileId: string;
  /** The invoice it pays. */
  invoiceFileId: string;
  setBy: ReceiptLinkSetBy;
  /** The File the link connected to the other's Transaction, if any. */
  connectedFileId: string | null;
}

export const RECEIPT_LINK_COPY_MESSAGE =
  "RECEIPT_LINK_COPY: a Copy cannot be part of a Receipt Link. Undo the Copy first (Not a Copy), then link the two Files.";

/**
 * Link a Receipt (`fileId`) to the invoice it pays (`invoiceFileId`).
 * Linking a suggested pair records it as accepted rather than typed in.
 */
export async function linkReceipt(db: Db, userId: string, args: Record<string, unknown>): Promise<LinkReceiptResult> {
  const fileId = requireId(args.fileId, "fileId");
  const invoiceFileId = requireId(args.invoiceFileId, "invoiceFileId");
  if (fileId === invoiceFileId) {
    throw new HttpsError("invalid-argument", "A File cannot be its own Receipt");
  }
  const receipt = await readOwned(db, "files", userId, fileId);
  const invoice = await readOwned(db, "files", userId, invoiceFileId);
  if (!isLive(receipt.data) || !isLive(invoice.data)) {
    throw new HttpsError("failed-precondition", "A deleted File cannot be linked. Restore it first.");
  }
  if (
    (await isLiveCopyFile(db, receipt.data)) ||
    (await isLiveCopyFile(db, invoice.data)) ||
    receipt.data.copyOfFileId === invoiceFileId ||
    invoice.data.copyOfFileId === fileId
  ) {
    throw new HttpsError("failed-precondition", RECEIPT_LINK_COPY_MESSAGE);
  }
  if (linkOf(invoice.data)) {
    throw new HttpsError(
      "failed-precondition",
      "That File is itself the Receipt of another invoice. Link this one to the invoice instead."
    );
  }
  const ownReceipts = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("receiptLink.fileId", "==", fileId)
    .limit(1)
    .get();
  if (!ownReceipts.empty) {
    throw new HttpsError(
      "failed-precondition",
      "This File has Receipts of its own, so it is an invoice. Unlink them first, or link them to the other invoice."
    );
  }

  const suggested =
    suggestionIds(receipt.data).includes(invoiceFileId) || suggestionIds(invoice.data).includes(fileId);
  const setBy: ReceiptLinkSetBy = suggested ? "suggested-accepted" : "manual";
  const now = Timestamp.now();
  // A Receipt pays one invoice: its other suggestions go with the link.
  await db.collection("files").doc(fileId).update({
    receiptLink: { fileId: invoiceFileId, setBy, setAt: now },
    receiptPairSuggestions: [],
    receiptPairDeclinedFileIds: FieldValue.arrayRemove(invoiceFileId),
    updatedAt: now,
  });
  for (const id of suggestionIds(receipt.data)) await dropSuggestion(db, userId, id, fileId, now);
  await db.collection("files").doc(invoiceFileId).update({
    receiptPairDeclinedFileIds: FieldValue.arrayRemove(fileId),
    updatedAt: now,
  });
  const connectedFileId = await followReceiptLink(db, userId, { receiptId: fileId, invoiceId: invoiceFileId });
  return { success: true, fileId, invoiceFileId, setBy, connectedFileId };
}

export interface UnlinkReceiptResult {
  success: true;
  fileId: string;
  /** "unlinked": a link was removed. "declined": a suggestion was turned down. */
  outcome: "unlinked" | "declined";
  /** The File never paired with this one again. */
  declinedFileId: string;
}

/**
 * Remove a Receipt Link, from the Receipt or from its invoice, or decline a
 * suggested pair (`otherFileId`). The pair is recorded as declined on both
 * Files, so the check never links or suggests it again; linking the pair by
 * hand revokes that. No File Connection changes: both Files stay where they
 * are, and each counts as an ordinary File.
 */
export async function unlinkReceipt(
  db: Db,
  userId: string,
  args: Record<string, unknown>
): Promise<UnlinkReceiptResult> {
  const fileId = requireId(args.fileId, "fileId");
  const file = await readOwned(db, "files", userId, fileId);
  const named = typeof args.otherFileId === "string" && args.otherFileId ? args.otherFileId : null;
  const own = linkOf(file.data);

  let receiptId: string | null = null;
  let otherId: string | null = null;
  if (own && (!named || named === own.fileId)) {
    receiptId = fileId;
    otherId = own.fileId;
  } else if (named) {
    const other = await readOwnedOrNull(db, userId, named);
    if (other && linkOf(other.data)?.fileId === fileId) {
      receiptId = named;
      otherId = named;
    }
  }

  const now = Timestamp.now();
  const decline = async (a: string, b: string, data: Data) => {
    const kept = ((data.receiptPairSuggestions ?? []) as Array<{ fileId: string }>).filter((s) => s?.fileId !== b);
    await db.collection("files").doc(a).update({
      receiptPairSuggestions: kept,
      receiptPairDeclinedFileIds: FieldValue.arrayUnion(b),
      ...(a === receiptId ? { receiptLink: null } : {}),
      updatedAt: now,
    });
  };

  if (receiptId && otherId) {
    const other = await readOwnedOrNull(db, userId, otherId);
    await decline(fileId, otherId, file.data);
    if (other) await decline(otherId, fileId, other.data);
    return { success: true, fileId, outcome: "unlinked", declinedFileId: otherId };
  }
  if (named && suggestionIds(file.data).includes(named)) {
    const other = await readOwnedOrNull(db, userId, named);
    await decline(fileId, named, file.data);
    if (other) await decline(named, fileId, other.data);
    return { success: true, fileId, outcome: "declined", declinedFileId: named };
  }
  throw new HttpsError("failed-precondition", "This File has no Receipt Link or pairing suggestion to remove");
}

// ============================================================================
// Inspecting
// ============================================================================

export interface ReceiptPairFileRef {
  fileId: string;
  fileName: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  transactionIds: string[];
}

export interface ReceiptLinkView {
  fileId: string;
  /** The invoice number this File cites as paid. */
  paidInvoiceNumber: string | null;
  /** The invoice this File is the Receipt of. */
  link: { invoiceFileId: string; setBy: ReceiptLinkSetBy } | null;
  invoice: ReceiptPairFileRef | null;
  /** The Receipts linked to this File, when it is an invoice. */
  receipts: Array<ReceiptPairFileRef & { setBy: ReceiptLinkSetBy }>;
  /**
   * Suggested pairs. `suggestedReceiptId` is the File prefilled as the
   * Receipt; null when the two tie and the person picks.
   */
  suggestions: Array<ReceiptPairFileRef & { suggestedReceiptId: string | null }>;
  /**
   * Files of the same Partner a person may link this File to as its invoice,
   * newest first. Read only when asked for (`withCandidates`).
   */
  candidates: ReceiptPairFileRef[];
}

/** Files of the same Partner offered for a manual link, at most. */
const MANUAL_CANDIDATES = 20;

function fileRef(id: string, data: Data): ReceiptPairFileRef {
  return {
    fileId: id,
    fileName: data.fileName ?? null,
    invoiceNumber: data.extractedInvoiceNumber ?? null,
    amount: data.extractedAmount ?? null,
    currency: data.extractedCurrency ?? null,
    date: dayOf(data.extractedDate),
    transactionIds: transactionIdsOf(data),
  };
}

export async function getReceiptLink(db: Db, userId: string, args: Record<string, unknown>): Promise<ReceiptLinkView> {
  const fileId = requireId(args.fileId, "fileId");
  const file = await readOwned(db, "files", userId, fileId);
  const own = linkOf(file.data);

  let invoice: ReceiptPairFileRef | null = null;
  if (own) {
    const o = await readOwnedOrNull(db, userId, own.fileId);
    if (o && isLive(o.data)) invoice = fileRef(o.id, o.data);
  }

  const receipts: ReceiptLinkView["receipts"] = [];
  const linkedSnap = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("receiptLink.fileId", "==", fileId)
    .get();
  for (const doc of linkedSnap.docs) {
    const d = doc.data();
    if (!isLive(d)) continue;
    receipts.push({ ...fileRef(doc.id, d), setBy: linkOf(d)?.setBy ?? "auto" });
  }

  const self = pairFile(fileId, file.data, false);
  const suggestions: ReceiptLinkView["suggestions"] = [];
  for (const id of suggestionIds(file.data)) {
    const f = await readOwnedOrNull(db, userId, id);
    if (!f || !isLive(f.data)) continue;
    suggestions.push({ ...fileRef(f.id, f.data), suggestedReceiptId: suggestedReceipt(self, pairFile(f.id, f.data, false)) });
  }

  // Only on request: the manual picker reads the Partner's Files.
  let candidates: ReceiptPairFileRef[] = [];
  if (args.withCandidates === true && !own && typeof file.data.partnerId === "string" && file.data.partnerId) {
    const snap = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", file.data.partnerId)
      .limit(CANDIDATE_LIMIT)
      .get();
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const copies = await liveCopyIds(db, docs);
    candidates = docs
      .filter(
        (c) =>
          c.id !== fileId &&
          isLive(c.data) &&
          c.data.isNotInvoice !== true &&
          !copies.has(c.id) &&
          !linkOf(c.data)
      )
      .sort((a, b) => (dayOf(b.data.extractedDate) ?? "").localeCompare(dayOf(a.data.extractedDate) ?? ""))
      .slice(0, MANUAL_CANDIDATES)
      .map((c) => fileRef(c.id, c.data));
  }

  return {
    fileId,
    paidInvoiceNumber: file.data.extractedPaidInvoiceNumber ?? null,
    link: own ? { invoiceFileId: own.fileId, setBy: own.setBy } : null,
    invoice,
    receipts,
    suggestions,
    candidates,
  };
}

// ============================================================================
// The one-time pass over stored Files
// ============================================================================

export interface BackfillReceiptPairsResult {
  success: true;
  /** Files read. */
  files: number;
  /** Files that now carry a pairing suggestion. */
  suggested: number;
}

/**
 * Runs the suggestion side of the pair check over every live File of the
 * user (story 38). Records no link: a stored File carries no cited number
 * until it is re-extracted, so every pair it finds is a person's to confirm.
 * Safe to run again.
 */
export async function backfillReceiptPairs(db: Db, userId: string): Promise<BackfillReceiptPairsResult> {
  const snap = await db.collection("files").where("userId", "==", userId).get();
  let files = 0;
  const suggested = new Set<string>();
  for (const doc of snap.docs) {
    // Re-read: an earlier File's pass may have written a suggestion here.
    const fresh = await db.collection("files").doc(doc.id).get();
    const data = fresh.data();
    if (!isLive(data) || data.isNotInvoice === true) continue;
    files++;
    const outcome = await runReceiptPairCheck(db, doc.id, data, { suggestOnly: true });
    if (outcome.suggested.length > 0) {
      suggested.add(doc.id);
      for (const id of outcome.suggested) suggested.add(id);
    }
  }
  return { success: true, files, suggested: suggested.size };
}
