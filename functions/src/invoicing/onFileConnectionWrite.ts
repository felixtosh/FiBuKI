import { onDocumentCreated, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const REGION = "europe-west1";

interface FileConnectionData {
  fileId: string;
  transactionId: string;
  userId: string;
}

async function syncInvoicePaidStatus(
  connection: FileConnectionData,
  event: "connected" | "disconnected",
): Promise<void> {
  const db = getFirestore();
  const fileSnap = await db.collection("files").doc(connection.fileId).get();
  if (!fileSnap.exists) return;

  const fileData = fileSnap.data();
  const invoiceId = fileData?.invoiceId as string | undefined;
  if (!invoiceId) return;

  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) return;

  const invoice = invoiceSnap.data() as { status: string; paidByTransactionId?: string };
  const now = Timestamp.now();

  if (event === "connected") {
    if (invoice.status !== "issued" && invoice.status !== "sent") return;
    await invoiceRef.update({
      status: "paid",
      paidByTransactionId: connection.transactionId,
      paidAt: now,
      updatedAt: now,
    });
    console.log(
      `[invoicing] Invoice ${invoiceId} auto-paid by transaction ${connection.transactionId}`,
    );
    return;
  }

  if (invoice.status === "paid" && invoice.paidByTransactionId === connection.transactionId) {
    // A pair written twice before #612 keeps its other record when the
    // duplicate is collapsed: the pair is still connected, so still paid.
    const remaining = await db
      .collection("fileConnections")
      .where("userId", "==", connection.userId)
      .where("fileId", "==", connection.fileId)
      .where("transactionId", "==", connection.transactionId)
      .limit(1)
      .get();
    if (!remaining.empty) return;

    await invoiceRef.update({
      status: "issued",
      paidByTransactionId: FieldValue.delete(),
      paidAt: FieldValue.delete(),
      updatedAt: now,
    });
    console.log(
      `[invoicing] Invoice ${invoiceId} reverted to issued after disconnect of transaction ${connection.transactionId}`,
    );
  }
}

export const onFileConnectionCreatedSyncInvoice = onDocumentCreated(
  {
    document: "fileConnections/{connectionId}",
    region: REGION,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data?.fileId || !data?.transactionId) return;
    try {
      await syncInvoicePaidStatus(data as FileConnectionData, "connected");
    } catch (err) {
      console.error("[invoicing] onFileConnectionCreated failed", err);
    }
  },
);

export const onFileConnectionDeletedSyncInvoice = onDocumentDeleted(
  {
    document: "fileConnections/{connectionId}",
    region: REGION,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data?.fileId || !data?.transactionId) return;
    try {
      await syncInvoicePaidStatus(data as FileConnectionData, "disconnected");
    } catch (err) {
      console.error("[invoicing] onFileConnectionDeleted failed", err);
    }
  },
);
