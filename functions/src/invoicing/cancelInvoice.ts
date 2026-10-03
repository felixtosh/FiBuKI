/**
 * Cancel an issued/sent/paid invoice (#133).
 *
 * Cancel issues an Invoice Correction (Rechnungskorrektur): a new invoice with
 * its own next number from the same sequence, the original's line items
 * negated, and a reference to the original ("Storno zu Rechnung …"). § 11 UStG
 * wants every number assigned once, so the correction never reuses or suffixes
 * the original's number.
 *
 * The original and its File stay on record (BAO § 132): the original only
 * becomes `cancelled` and points at its correction, which points back. The
 * correction's File enters the pipeline like any issued invoice's, so the UVA
 * sees the original and its reversal side by side instead of a hole.
 *
 * Undo-issue (#272) stays the only path that removes a document. Undoing a
 * correction and discarding its draft takes the Cancel back (deleteInvoice).
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { Invoice } from "./types";
import { nextInvoiceNumberSeq } from "./numberAllocator";
import { draftFileStubFields, draftPlaceholderNumber } from "./buildInvoiceFileFields";
import { IssueInvoiceDeps, IssueInvoiceResponse, performIssueInvoice } from "./issueInvoice";

export interface CancelInvoiceRequest {
  invoiceId: string;
}

export interface CancelInvoiceResponse {
  success: boolean;
  invoiceId: string;
  status: "cancelled";
  /** The Invoice Correction that cancels it. */
  correctionInvoiceId: string;
  correctionNumber: string;
  correctionFileId: string;
}

const CANCELLABLE = new Set(["issued", "sent", "paid"]);

/** Today's Europe/Vienna calendar day, stored as UTC midnight. */
function viennaToday(): Timestamp {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(new Date());
  return Timestamp.fromDate(new Date(`${day}T00:00:00Z`));
}

/** The draft of the correction: the original with every line negated. */
function correctionDraft(
  original: Invoice,
  originalId: string,
  fileId: string,
  issueDate: Timestamp,
  numberSeq: number,
  now: Timestamp,
): Omit<Invoice, "id"> {
  const draft: Omit<Invoice, "id"> = {
    userId: original.userId,
    number: draftPlaceholderNumber(),
    status: "draft",
    numberSeq,
    issuer: original.issuer,
    recipient: original.recipient,
    issueDate,
    paymentTerms: original.paymentTerms,
    dueDate: issueDate,
    lineItems: original.lineItems.map((li) => ({ ...li, unitPrice: 0 - li.unitPrice })),
    currency: original.currency,
    // The original's frozen totals, reversed: a correction takes back exactly
    // what the original stated, never a recomputation of it.
    subtotal: 0 - original.subtotal,
    vatAmount: 0 - original.vatAmount,
    total: 0 - original.total,
    fileId,
    correctsInvoice: {
      invoiceId: originalId,
      number: original.number,
      issueDate: original.issueDate,
    },
    createdAt: now,
    updatedAt: now,
  };
  if (original.namePrefix) draft.namePrefix = original.namePrefix;
  // A correction of a service supplied abroad prints the same note (#565).
  if (original.supplyAbroad) draft.supplyAbroad = true;
  return draft;
}

/** Move a correction's draft to the next free number of its year. */
async function renumberCorrection(
  db: FirebaseFirestore.Firestore,
  userId: string,
  correctionId: string,
): Promise<void> {
  const ref = db.collection("invoices").doc(correctionId);
  const draft = (await ref.get()).data() as Invoice;
  const numberSeq = await nextInvoiceNumberSeq(db, userId, draft.issueDate.toDate().getFullYear());
  await ref.update({ numberSeq, updatedAt: Timestamp.now() });
}

const ISSUE_ATTEMPTS = 3;

async function issueCorrection(
  db: FirebaseFirestore.Firestore,
  userId: string,
  originalId: string,
  correctionId: string,
  deps: IssueInvoiceDeps | undefined,
): Promise<CancelInvoiceResponse> {
  // The number is picked before it is claimed, so a cancel or issue running
  // alongside can take it first. Issuing then refuses it, and the correction
  // moves on to the next free number.
  let issued: IssueInvoiceResponse;
  for (let attempt = 1; ; attempt++) {
    try {
      issued = await performIssueInvoice(db, userId, { invoiceId: correctionId }, deps);
      break;
    } catch (err) {
      if (attempt >= ISSUE_ATTEMPTS || (err as { code?: unknown })?.code !== "already-exists") throw err;
      await renumberCorrection(db, userId, correctionId);
    }
  }
  const correction = (await db.collection("invoices").doc(correctionId).get()).data() as Invoice;
  return {
    success: true,
    invoiceId: originalId,
    status: "cancelled",
    correctionInvoiceId: correctionId,
    correctionNumber: correction.number,
    correctionFileId: issued.fileId,
  };
}

/**
 * Internal implementation for cancelling an invoice.
 * Can be called directly from MCP handlers.
 */
export async function performCancelInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: CancelInvoiceRequest,
  deps?: IssueInvoiceDeps,
): Promise<CancelInvoiceResponse> {
  if (!request?.invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId is required");
  }
  const invoiceRef = db.collection("invoices").doc(request.invoiceId);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found");
  }
  const inv = snap.data() as Invoice;
  if (inv.userId !== userId) {
    throw new HttpsError("permission-denied", "Not your invoice");
  }
  if (inv.correctsInvoice) {
    throw new HttpsError(
      "failed-precondition",
      `This is the Invoice Correction of invoice ${inv.correctsInvoice.number}; a correction cannot be cancelled. To take the Cancel back, undo the correction's issue and discard the draft.`,
    );
  }

  // A cancel that stopped after claiming the original but before issuing its
  // correction (a failed render or upload) finishes here when called again.
  if (inv.status === "cancelled" && inv.correctedByInvoiceId) {
    const correction = await db.collection("invoices").doc(inv.correctedByInvoiceId).get();
    const data = correction.exists ? (correction.data() as Invoice) : null;
    if (data?.userId === userId && data.status === "draft") {
      return issueCorrection(db, userId, invoiceRef.id, correction.id, deps);
    }
    throw new HttpsError(
      "failed-precondition",
      `This invoice is already cancelled${data?.number ? ` by invoice ${data.number}` : ""}.`,
    );
  }
  if (!CANCELLABLE.has(inv.status)) {
    throw new HttpsError(
      "failed-precondition",
      "Only issued/sent/paid invoices can be cancelled",
    );
  }

  const issueDate = viennaToday();
  const numberSeq = await nextInvoiceNumberSeq(db, userId, issueDate.toDate().getFullYear());
  const correctionRef = db.collection("invoices").doc();
  const fileRef = db.collection("files").doc();

  // Claim the original and create the correction's draft together, so two
  // concurrent cancels cannot both issue a correction. No side effects in here:
  // the callback can run more than once.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(invoiceRef);
    const current = fresh.data() as Invoice | undefined;
    if (!current || !CANCELLABLE.has(current.status) || current.correctedByInvoiceId) {
      throw new HttpsError("failed-precondition", "This invoice is already being cancelled.");
    }
    const now = Timestamp.now();
    tx.update(invoiceRef, {
      status: "cancelled",
      cancelledAt: now,
      correctedByInvoiceId: correctionRef.id,
      updatedAt: now,
    });
    tx.set(
      correctionRef,
      correctionDraft(current, invoiceRef.id, fileRef.id, issueDate, numberSeq, now),
    );
    tx.set(fileRef, {
      userId,
      ...draftFileStubFields(correctionRef.id),
      transactionIds: [],
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  return issueCorrection(db, userId, invoiceRef.id, correctionRef.id, deps);
}

export const cancelInvoiceCallable = createCallable<
  CancelInvoiceRequest,
  CancelInvoiceResponse
>(
  { name: "cancelInvoice", memory: "1GiB", timeoutSeconds: 120 },
  async (ctx, request) => performCancelInvoice(ctx.db, ctx.userId, request),
);
