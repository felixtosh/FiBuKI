/**
 * Regenerate the PDF for an already-issued invoice.
 * Used after layout fixes. Does NOT re-trigger matching.
 */

import { Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createCallable, HttpsError } from "../utils/createCallable";
import { Invoice } from "./types";
import { renderInvoicePdf } from "./renderInvoicePdf";
import { buildInvoiceFileFields } from "./buildInvoiceFileFields";

export interface RegenerateInvoicePdfRequest {
  invoiceId: string;
}

export interface RegenerateInvoicePdfResponse {
  success: boolean;
  fileId: string;
  downloadUrl: string;
}

/**
 * Internal implementation for regenerating an invoice PDF.
 * Can be called directly from MCP handlers.
 */
export async function performRegenerateInvoicePdf(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: RegenerateInvoicePdfRequest,
): Promise<RegenerateInvoicePdfResponse> {
  if (!request?.invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId is required");
  }

  const invoiceRef = db.collection("invoices").doc(request.invoiceId);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found");
  }
  const invoice = { ...(snap.data() as Invoice), id: invoiceRef.id };
  if (invoice.userId !== userId) {
    throw new HttpsError("permission-denied", "Not your invoice");
  }
  if (invoice.status !== "issued" && invoice.status !== "sent" && invoice.status !== "paid") {
    throw new HttpsError(
      "failed-precondition",
      "Only issued/sent/paid invoices can be re-rendered",
    );
  }
  if (!invoice.fileId) {
    throw new HttpsError("failed-precondition", "Invoice has no linked file");
  }

  const buffer = await renderInvoicePdf(invoice);
  const storagePath = `files/${userId}/invoices/${invoice.id}_v1.pdf`;
  const bucket = getStorage().bucket();
  const storageFile = bucket.file(storagePath);
  await storageFile.save(buffer, {
    contentType: "application/pdf",
    metadata: {
      cacheControl: "private, max-age=0, no-store",
      contentDisposition: `inline; filename="${invoice.number}.pdf"`,
    },
  });
  await storageFile.makePublic();
  // Append a version query param so iframe / browser caches don't keep
  // serving the prior PDF bytes after regen.
  const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}?v=${Date.now()}`;

  const fileFields = buildInvoiceFileFields(invoice, {
    storagePath,
    downloadUrl,
    fileSize: buffer.length,
  });
  await db.collection("files").doc(invoice.fileId).update(fileFields);

  await invoiceRef.update({ updatedAt: Timestamp.now() });

  return { success: true, fileId: invoice.fileId, downloadUrl };
}

export const regenerateInvoicePdfCallable = createCallable<
  RegenerateInvoicePdfRequest,
  RegenerateInvoicePdfResponse
>(
  { name: "regenerateInvoicePdf", memory: "1GiB", timeoutSeconds: 120 },
  async (ctx, request) => performRegenerateInvoicePdf(ctx.db, ctx.userId, request),
);
