/**
 * Issue an invoice.
 *
 * 1. Allocate real invoice number atomically.
 * 2. Render PDF.
 * 3. Upload to Storage.
 * 4. Create linked TaxFile (with isFibukiGenerated + extractionComplete=false at first).
 * 5. Flip extractionComplete=true so matchFilePartner trigger fires.
 * 6. Optionally create a share link.
 */

import { Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import { createCallable, HttpsError } from "../utils/createCallable";
import { Invoice, InvoicePartnerAddress } from "./types";
import { allocateInvoiceNumber } from "./numberAllocator";
import { renderInvoicePdf } from "./renderInvoicePdf";

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

function formatAddressOneLine(addr?: InvoicePartnerAddress): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  if (addr.street) parts.push(addr.street);
  const postalCity = [addr.postalCode, addr.city].filter(Boolean).join(" ");
  if (postalCity) parts.push(postalCity);
  if (addr.country) parts.push(addr.country);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

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

  // 1. Allocate the real invoice number
  const number = await allocateInvoiceNumber(db, userId);
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

  // 2. Render PDF
  const pdfBuffer = await renderInvoicePdf(issuedInvoice);

  // 3. Upload to Storage
  const storagePath = `files/${userId}/invoices/${invoiceRef.id}_v1.pdf`;
  const bucket = getStorage().bucket();
  const storageFile = bucket.file(storagePath);
  await storageFile.save(pdfBuffer, {
    contentType: "application/pdf",
    metadata: { cacheControl: "private, max-age=0, no-store" },
  });
  await storageFile.makePublic();
  const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

  // 4. Update the TaxFile record. createInvoice already created a stub
  // TaxFile (so the draft appears in the files list); we update it in place
  // here with the real PDF + extracted data. Fall back to creating a new
  // file if the stub is missing (legacy drafts created before this change).
  const recipientAddressLine = formatAddressOneLine(issuedInvoice.recipient.address);

  const extractedLineItems = issuedInvoice.lineItems.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    vatPercent: li.vatRate,
    vatAmount: Math.round((li.quantity * li.unitPrice * li.vatRate) / 100),
    amount: Math.round(li.quantity * li.unitPrice * (1 + li.vatRate / 100)),
  }));

  const fileFields: Record<string, unknown> = {
    fileName: `Rechnung-${number}.pdf`,
    fileType: "application/pdf",
    fileSize: pdfBuffer.length,
    storagePath,
    downloadUrl,
    // Pipeline flags
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    invoiceId: invoiceRef.id,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
    // Extracted data pre-filled from the invoice
    extractedDate: issuedInvoice.issueDate,
    extractedAmount: issuedInvoice.total,
    extractedCurrency: issuedInvoice.currency,
    extractedVatAmount: issuedInvoice.vatAmount,
    extractedPartner: issuedInvoice.recipient.name,
    extractedIban: issuedInvoice.issuer.iban,
    extractedLineItems,
    extractedIssuer: {
      name: issuedInvoice.issuer.name,
      vatId: issuedInvoice.issuer.vatId || null,
      address: formatAddressOneLine(issuedInvoice.issuer.address) || null,
      iban: issuedInvoice.issuer.iban,
      website: null,
    },
    extractedRecipient: {
      name: issuedInvoice.recipient.name,
      vatId: issuedInvoice.recipient.vatId || null,
      address: recipientAddressLine || null,
      iban: null,
      website: null,
    },
    updatedAt: Timestamp.now(),
  };

  if (issuedInvoice.recipient.vatId) {
    fileFields.extractedVatId = issuedInvoice.recipient.vatId;
  }
  if (recipientAddressLine) {
    fileFields.extractedAddress = recipientAddressLine;
  }

  let fileRef: FirebaseFirestore.DocumentReference;
  if (current.fileId) {
    fileRef = db.collection("files").doc(current.fileId);
  } else {
    fileRef = db.collection("files").doc();
  }
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

  // 6. Update invoice with file backref + new status
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
