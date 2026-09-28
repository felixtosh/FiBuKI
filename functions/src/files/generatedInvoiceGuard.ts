/**
 * FiBuKI-generated invoice documents cannot be deleted (ADR-0006).
 *
 * Deleting the PDF under an issued invoice is not a cheaper cancellation;
 * cancelling is its own accounting act with its own writer. This module only
 * answers "is this File such a document, and what is the refusal"; each delete
 * door decides to call it. Today that is the tool surface (#267). Extending it
 * to the other doors is tracked in #297.
 */

export const GENERATED_INVOICE_ERROR = "GENERATED_INVOICE";

/** Whether a File record is a document FiBuKI generated for an invoice. */
export function isGeneratedInvoiceFile(fileData: FirebaseFirestore.DocumentData): boolean {
  return (
    fileData.isFibukiGenerated === true ||
    fileData.sourceType === "fibuki_invoice" ||
    (typeof fileData.invoiceId === "string" && fileData.invoiceId.length > 0)
  );
}

/**
 * The refusal message for deleting a generated invoice document, naming the
 * invoice, or null when the File is not one.
 */
export async function generatedInvoiceRefusal(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<string | null> {
  if (!isGeneratedInvoiceFile(fileData)) return null;

  const invoiceId = typeof fileData.invoiceId === "string" ? fileData.invoiceId : null;
  let label = invoiceId ? `invoice ${invoiceId}` : "an invoice";
  let status: string | null = null;

  if (invoiceId) {
    const snap = await db.collection("invoices").doc(invoiceId).get();
    const invoice = snap.exists ? snap.data() : undefined;
    if (invoice && invoice.userId === userId) {
      status = typeof invoice.status === "string" ? invoice.status : null;
      if (invoice.number) label = `invoice ${invoice.number} (${invoiceId})`;
    }
  }

  const way =
    status === "draft"
      ? "It belongs to a draft; the draft is discarded with the invoice, not by deleting its document."
      : "To withdraw the invoice, cancel it with cancel_invoice.";

  return (
    `${GENERATED_INVOICE_ERROR}: this file is the document FiBuKI generated for ${label}. ` +
    `Generated invoice documents cannot be deleted (ADR-0006). ${way}`
  );
}
