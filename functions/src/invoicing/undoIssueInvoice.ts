/**
 * Un-issue a misclicked invoice (#272): back to an editable draft, its
 * generated document destroyed.
 *
 * This is the one exception ADR-0006 makes to "an issued invoice's document is
 * never deleted", and it is only allowed while undoing is provably harmless:
 *
 * - the invoice is `issued`, never sent and never paid (its document is not
 *   connected to a Transaction);
 * - no share link of it was ever opened, revoked links included;
 * - it was issued in the current year;
 * - it holds the highest number issued in that year, so taking it back leaves
 *   the § 11 UStG sequence gapless. Later drafts do not count: they hold no
 *   frozen number.
 *
 * The draft keeps its numberSeq, so re-issuing it gives the same number.
 * Everything else is Storno via cancel_invoice.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createCallable, HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import { viennaYear, yearOf } from "../utils/storedDay";
import { Invoice, InvoiceShare } from "./types";
import { draftFileStubFields, draftPlaceholderNumber } from "./buildInvoiceFileFields";

export interface UndoIssueInvoiceRequest {
  invoiceId: string;
}

export interface UndoIssueInvoiceResponse {
  success: boolean;
  invoiceId: string;
  status: "draft";
  numberSeq: number;
}

export interface UndoIssueInvoiceDeps {
  /** Destroy the stored PDF. Must not throw when the object is already gone. */
  deleteStoredDocument: (storagePath: string) => Promise<void>;
}

const defaultDeps: UndoIssueInvoiceDeps = {
  deleteStoredDocument: async (storagePath) => {
    await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
  },
};

/** File fields a draft's stub carries besides `draftFileStubFields`. */
const KEPT_FILE_FIELDS = new Set(["userId", "transactionIds", "uploadedAt", "createdAt", "deletedAt"]);

const STORNO_HINT = "Withdraw it with a Storno (cancel_invoice) instead.";

function refuse(reason: string): never {
  throw new HttpsError("failed-precondition", `${reason} ${STORNO_HINT}`);
}

/** The sequence number an invoice holds in `year`, or null. */
function seqInYear(data: Partial<Invoice>, year: number): number | null {
  const issued = toDateSafe(data.issueDate);
  const docYear = issued ? yearOf(issued) : null;
  if (docYear !== null && docYear !== year) return null;
  if (typeof data.numberSeq === "number") return data.numberSeq;
  const legacy = typeof data.number === "string" ? data.number.match(new RegExp(`${year}-(\\d{1,6})$`)) : null;
  return legacy ? parseInt(legacy[1], 10) : null;
}

export async function performUndoIssueInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: UndoIssueInvoiceRequest,
  deps: UndoIssueInvoiceDeps = defaultDeps,
): Promise<UndoIssueInvoiceResponse> {
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

  if (inv.status !== "issued") {
    refuse("Only an issued invoice that was never sent or paid can be undone.");
  }
  if (inv.sentAt || inv.sentVia) {
    refuse("This invoice was sent, so the customer may hold a copy.");
  }
  if (typeof inv.numberSeq !== "number") {
    refuse("This invoice was numbered by the legacy counter and cannot be taken back.");
  }

  const year = viennaYear();
  const issued = toDateSafe(inv.issueDate);
  if (!issued || yearOf(issued) !== year) {
    refuse("Only an invoice of the current year can be undone.");
  }

  const others = await db.collection("invoices").where("userId", "==", userId).get();
  const higher = others.docs.some((doc) => {
    if (doc.id === invoiceRef.id) return false;
    const data = doc.data() as Partial<Invoice>;
    if (data.status === "draft") return false;
    const seq = seqInYear(data, year);
    return seq !== null && seq > inv.numberSeq!;
  });
  if (higher) {
    refuse("A later invoice of this year was already issued, so undoing this one would leave a gap.");
  }

  const shares = await db.collection("invoiceShares").where("invoiceId", "==", invoiceRef.id).get();
  const ownShares = shares.docs.filter((d) => (d.data() as InvoiceShare).userId === userId);
  if (ownShares.some((d) => ((d.data() as InvoiceShare).accessCount ?? 0) > 0)) {
    refuse("A share link of this invoice was opened, so the customer may hold a copy.");
  }

  const fileRef = inv.fileId ? db.collection("files").doc(inv.fileId) : null;
  const fileSnap = fileRef ? await fileRef.get() : null;
  const file = fileSnap?.exists ? (fileSnap.data() as Record<string, unknown>) : null;
  if (Array.isArray(file?.transactionIds) && file.transactionIds.length > 0) {
    refuse("This invoice's document is connected to a Transaction, so it counts as paid.");
  }

  const now = Timestamp.now();
  const batch = db.batch();

  batch.update(invoiceRef, {
    status: "draft",
    number: draftPlaceholderNumber(),
    issuedAt: FieldValue.delete(),
    shareToken: FieldValue.delete(),
    shareTokenCreatedAt: FieldValue.delete(),
    updatedAt: now,
  });

  for (const share of ownShares) {
    if (!(share.data() as InvoiceShare).revokedAt) {
      batch.update(share.ref, { revokedAt: now });
    }
  }

  const storagePath = typeof file?.storagePath === "string" ? file.storagePath : "";
  if (fileRef && file) {
    const reset: Record<string, unknown> = { ...draftFileStubFields(invoiceRef.id), updatedAt: now };
    for (const key of Object.keys(file)) {
      if (!(key in reset) && !KEPT_FILE_FIELDS.has(key)) reset[key] = FieldValue.delete();
    }
    batch.update(fileRef, reset);
  }

  await batch.commit();

  if (storagePath) {
    await deps.deleteStoredDocument(storagePath);
  }

  return { success: true, invoiceId: invoiceRef.id, status: "draft", numberSeq: inv.numberSeq! };
}

export const undoIssueInvoiceCallable = createCallable<
  UndoIssueInvoiceRequest,
  UndoIssueInvoiceResponse
>(
  { name: "undoIssueInvoice" },
  async (ctx, request) => performUndoIssueInvoice(ctx.db, ctx.userId, request),
);
