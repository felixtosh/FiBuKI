import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { enqueueExtraction } from "./extractionQueue";

/**
 * Triggered when a file document is updated.
 * Asks for an Extraction when the File was undeleted (deletedAt went from
 * non-null to null) and its Extraction is not complete.
 */
export const extractFileDataOnUndelete = onDocumentUpdated(
  {
    document: "files/{fileId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 10,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const fileId = event.params.fileId;

    // Fibuki-generated invoices already have all fields pre-filled; never extract.
    if (after.isFibukiGenerated) {
      console.log(`File ${fileId} is Fibuki-generated, skipping extraction`);
      return;
    }

    const wasDeleted = !!before.deletedAt;
    const isNowNotDeleted = !after.deletedAt;
    const needsExtraction = !after.extractionComplete;

    if (wasDeleted && isNowNotDeleted && needsExtraction) {
      console.log(`[${new Date().toISOString()}] File ${fileId} was undeleted, queueing extraction`);
      await enqueueExtraction({
        fileId,
        userId: after.userId as string,
        skipClassification: false,
        kind: "new",
      });
    }
  }
);

/**
 * Triggered when a new file document is created.
 * Asks for an Extraction; the extraction worker runs it (#603), so a slow
 * Extraction never holds the trigger queue.
 */
export const extractFileData = onDocumentCreated(
  {
    document: "files/{fileId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 10, // Limit concurrency to prevent Gemini API rate limits
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const fileId = event.params.fileId;
    const fileData = snapshot.data();

    // Skip if already processed
    if (fileData.extractionComplete) {
      console.log(`File ${fileId} already processed, skipping`);
      return;
    }

    // Fibuki-generated invoices already have all fields pre-filled; never extract.
    if (fileData.isFibukiGenerated) {
      console.log(`File ${fileId} is Fibuki-generated, skipping extraction`);
      return;
    }

    if (fileData.deletedAt) {
      console.log(`File ${fileId} is soft-deleted, skipping extraction`);
      return;
    }

    await enqueueExtraction({
      fileId,
      userId: fileData.userId as string,
      skipClassification: false,
      kind: "new",
    });
  }
);
