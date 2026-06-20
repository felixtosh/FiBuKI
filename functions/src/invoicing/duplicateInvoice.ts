/**
 * Duplicate an invoice as a new draft.
 * Strips number, fileId, shareToken, and lifecycle timestamps.
 * issueDate becomes today; dueDate recomputed.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { Invoice, parsePaymentTermsToDays } from "./types";

export interface DuplicateInvoiceRequest {
  invoiceId: string;
}

export interface DuplicateInvoiceResponse {
  success: boolean;
  invoiceId: string;
  /** Stub TaxFile id created for the new draft. */
  fileId: string;
}

function shortRandomId(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function addDaysToTimestamp(ts: Timestamp, days: number): Timestamp {
  const d = ts.toDate();
  d.setDate(d.getDate() + days);
  return Timestamp.fromDate(d);
}

/**
 * Internal implementation for duplicating an invoice.
 * Can be called directly from MCP handlers.
 */
export async function performDuplicateInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: DuplicateInvoiceRequest,
): Promise<DuplicateInvoiceResponse> {
  if (!request?.invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId is required");
  }

  const srcRef = db.collection("invoices").doc(request.invoiceId);
  const srcSnap = await srcRef.get();
  if (!srcSnap.exists) {
    throw new HttpsError("not-found", "Invoice not found");
  }
  const src = srcSnap.data() as Invoice;
  if (src.userId !== userId) {
    throw new HttpsError("permission-denied", "Not your invoice");
  }

  const now = Timestamp.now();
  const dueDate = addDaysToTimestamp(now, parsePaymentTermsToDays(src.paymentTerms));

  const newRef = db.collection("invoices").doc();
  const newFileRef = db.collection("files").doc();
  const newData: Omit<Invoice, "id"> = {
    userId,
    number: `DRAFT-${shortRandomId()}`,
    status: "draft",
    issuer: src.issuer,
    recipient: src.recipient,
    issueDate: now,
    paymentTerms: src.paymentTerms,
    dueDate,
    lineItems: src.lineItems.map((li) => ({ ...li })),
    currency: src.currency,
    subtotal: src.subtotal,
    vatAmount: src.vatAmount,
    total: src.total,
    fileId: newFileRef.id,
    createdAt: now,
    updatedAt: now,
  };
  if (src.notes) (newData as Invoice).notes = src.notes;

  // Stub TaxFile so the new draft appears in the files list.
  const newFileData: Record<string, unknown> = {
    userId,
    fileName: "Rechnungsentwurf",
    fileType: "application/pdf",
    fileSize: 0,
    storagePath: "",
    downloadUrl: "",
    extractionComplete: true,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    invoiceId: newRef.id,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
    transactionIds: [],
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  batch.set(newRef, newData);
  batch.set(newFileRef, newFileData);
  await batch.commit();

  return { success: true, invoiceId: newRef.id, fileId: newFileRef.id };
}

export const duplicateInvoiceCallable = createCallable<
  DuplicateInvoiceRequest,
  DuplicateInvoiceResponse
>(
  { name: "duplicateInvoice" },
  async (ctx, request) => performDuplicateInvoice(ctx.db, ctx.userId, request),
);
