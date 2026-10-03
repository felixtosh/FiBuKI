/**
 * Issue an invoice.
 *
 * 1. Compose the invoice number and claim it: refused when another invoice
 *    already holds it (§ 11 Abs 1 Z 5 UStG). A later failure gives it back.
 * 2. Render PDF.
 * 3. Upload to Storage.
 * 4. Create linked TaxFile (with isFibukiGenerated + extractionComplete=false at first).
 * 5. Flip extractionComplete=true so matchFilePartner trigger fires.
 * 6. Optionally create a share link.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { buildStorageObjectUrl } from "../utils/buildDownloadUrl";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import { createCallable, HttpsError } from "../utils/createCallable";
import { Invoice, composeInvoiceName } from "./types";
import { allocateInvoiceNumber, assertInvoiceNumberFree } from "./numberAllocator";
import { renderInvoicePdf } from "./renderInvoicePdf";
import { buildInvoiceFileFields } from "./buildInvoiceFileFields";

export interface IssueInvoiceRequest {
  invoiceId: string;
  createShareLink?: boolean;
}

export interface IssueInvoiceResponse {
  success: boolean;
  invoiceId: string;
  fileId: string;
  downloadUrl: string;
  shareUrl?: string;
  shareToken?: string;
}

export interface IssueInvoiceDeps {
  renderPdf: (invoice: Invoice) => Promise<Buffer>;
  /** Store the rendered PDF at `storagePath`; returns its download URL. */
  storeDocument: (storagePath: string, pdf: Buffer, fileName: string) => Promise<string>;
}

const defaultDeps: IssueInvoiceDeps = {
  renderPdf: renderInvoicePdf,
  storeDocument: async (storagePath, pdf, fileName) => {
    const bucket = getStorage().bucket();
    const storageFile = bucket.file(storagePath);
    await storageFile.save(pdf, {
      contentType: "application/pdf",
      metadata: {
        cacheControl: "private, max-age=0, no-store",
        contentDisposition: `inline; filename="${fileName}"`,
      },
    });
    await storageFile.makePublic();
    // Append a version query param so iframe / browser caches don't keep
    // serving prior PDF bytes after regen.
    return buildStorageObjectUrl(bucket.name, storagePath, { cacheBust: true });
  },
};

function genShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Internal implementation for issuing an invoice.
 * Can be called directly from MCP handlers.
 */
export async function performIssueInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: IssueInvoiceRequest,
  deps: IssueInvoiceDeps = defaultDeps,
): Promise<IssueInvoiceResponse> {
  if (!request?.invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId is required");
  }

  const invoiceRef = db.collection("invoices").doc(request.invoiceId);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found");
  }
  const current = snap.data() as Invoice;
  if (current.userId !== userId) {
    throw new HttpsError("permission-denied", "Not your invoice");
  }
  if (current.status !== "draft") {
    throw new HttpsError("failed-precondition", "Only drafts can be issued");
  }
  if (!current.lineItems || current.lineItems.length === 0) {
    throw new HttpsError("failed-precondition", "Invoice must have at least one line item");
  }
  if (!current.recipient?.partnerId || !current.recipient?.name) {
    throw new HttpsError("failed-precondition", "Pick an invoice recipient first");
  }
  if (!current.issuer?.entityId || !current.issuer?.iban || !current.issuer?.name) {
    throw new HttpsError("failed-precondition", "Pick a sender bank account first");
  }

  // 1. Compose the invoice number from namePrefix + year + numberSeq. Legacy
  // drafts without numberSeq fall back to the atomic per-user allocator so we
  // never end up with an unnumbered issued invoice.
  const issueYear = current.issueDate.toDate().getFullYear();
  let number: string;
  if (typeof current.numberSeq === "number" && current.numberSeq >= 1) {
    number = composeInvoiceName({
      namePrefix: current.namePrefix,
      recipientName: current.recipient?.name,
      year: issueYear,
      numberSeq: current.numberSeq,
    });
  } else {
    number = await allocateInvoiceNumber(db, userId);
  }
  const now = Timestamp.now();

  // Build the issued invoice in-memory for the PDF (don't rely on a re-read)
  const issuedInvoice: Invoice = {
    ...current,
    id: invoiceRef.id,
    number,
    status: "issued",
    issuedAt: now,
    updatedAt: now,
  };

  async function renderAndFile() {
    // 2. Render PDF
    const pdfBuffer = await deps.renderPdf(issuedInvoice);

    // 3. Upload to Storage
    const storagePath = `files/${userId}/invoices/${invoiceRef.id}_v1.pdf`;
    const downloadUrl = await deps.storeDocument(storagePath, pdfBuffer, `${number}.pdf`);

    // 4. Update the TaxFile record. createInvoice already created a stub
    // TaxFile (so the draft appears in the files list); we update it in place
    // here with the real PDF + extracted data. Fall back to creating a new
    // file if the stub is missing (legacy drafts created before this change).
    const fileFields = buildInvoiceFileFields(issuedInvoice, {
      storagePath,
      downloadUrl,
      fileSize: pdfBuffer.length,
    });

    const fileRef = current.fileId
      ? db.collection("files").doc(current.fileId)
      : db.collection("files").doc();
    const existing = await fileRef.get();

    if (existing.exists) {
      // Stub TaxFile created at draft time — fill it in. extractionComplete is
      // already true (set at stub creation), so we flip it false then true to
      // trigger matchFilePartner.
      await fileRef.update({
        ...fileFields,
        extractionComplete: false,
      });
      await fileRef.update({
        extractionComplete: true,
        updatedAt: Timestamp.now(),
      });
    } else {
      // Legacy path: no stub exists. Create the file fresh.
      await fileRef.set({
        ...fileFields,
        userId,
        extractionComplete: false, // flipped to true below so matchFilePartner fires
        transactionIds: [],
        uploadedAt: now,
        createdAt: now,
      });
      await fileRef.update({
        extractionComplete: true,
        updatedAt: Timestamp.now(),
      });
    }
    return { fileRef, downloadUrl };
  }

  // Claim the number before anything is rendered: no second invoice may
  // carry it, and no PDF is printed with a number that turns out taken.
  await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(invoiceRef)).data() as Invoice | undefined;
    if (fresh?.status !== "draft") {
      throw new HttpsError("failed-precondition", "Only drafts can be issued");
    }
    await assertInvoiceNumberFree(tx, db, userId, number, invoiceRef.id);
    tx.update(invoiceRef, { number, status: "issued", issuedAt: now, updatedAt: now });
  });

  // A failed render or upload hands the number back: the invoice is a draft
  // again, exactly as before the attempt.
  let fileRef: FirebaseFirestore.DocumentReference;
  let downloadUrl: string;
  try {
    ({ fileRef, downloadUrl } = await renderAndFile());
  } catch (err) {
    await invoiceRef.update({
      status: "draft",
      number: current.number,
      issuedAt: FieldValue.delete(),
      updatedAt: Timestamp.now(),
    });
    throw err;
  }

  // 6. Update invoice with file backref (number and status were claimed above)
  const invoiceUpdates: Record<string, unknown> = {
    number,
    status: "issued",
    issuedAt: now,
    fileId: fileRef.id,
    updatedAt: Timestamp.now(),
  };

  // 7. Optional share link
  let shareToken: string | undefined;
  let shareUrl: string | undefined;
  if (request.createShareLink) {
    shareToken = genShareToken();
    shareUrl = `/i/${shareToken}`;
    await db.collection("invoiceShares").doc(shareToken).set({
      token: shareToken,
      invoiceId: invoiceRef.id,
      userId,
      createdAt: now,
      accessCount: 0,
    });
    invoiceUpdates.shareToken = shareToken;
    invoiceUpdates.shareTokenCreatedAt = now;
  }

  await invoiceRef.update(invoiceUpdates);

  const response: IssueInvoiceResponse = {
    success: true,
    invoiceId: invoiceRef.id,
    fileId: fileRef.id,
    downloadUrl,
  };
  if (shareToken) {
    response.shareToken = shareToken;
    response.shareUrl = shareUrl;
  }
  return response;
}

export const issueInvoiceCallable = createCallable<
  IssueInvoiceRequest,
  IssueInvoiceResponse
>(
  { name: "issueInvoice", memory: "1GiB", timeoutSeconds: 120 },
  async (ctx, request) => performIssueInvoice(ctx.db, ctx.userId, request),
);
