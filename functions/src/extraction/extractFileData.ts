import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { runExtraction } from "./extractionCore";

const db = getFirestore();

/**
 * Triggered when a file document is updated.
 * Re-runs extraction when:
 * - File was undeleted (deletedAt went from non-null to null)
 * - extractionComplete is false
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

    // Check if this is an undelete operation
    const wasDeleted = !!before.deletedAt;
    const isNowNotDeleted = !after.deletedAt;
    const needsExtraction = !after.extractionComplete;

    if (wasDeleted && isNowNotDeleted && needsExtraction) {
      console.log(`[${new Date().toISOString()}] File ${fileId} was undeleted, starting extraction`);

      try {
        await runExtraction(fileId, after, {
          skipClassification: false,
        });
      } catch (error) {
        console.error(`Extraction failed for undeleted file ${fileId}:`, error);
        await db.collection("files").doc(fileId).update({
          extractionComplete: true,
          extractionError: error instanceof Error ? error.message : "Unknown extraction error",
          updatedAt: Timestamp.now(),
        });
      }
    }
  }
);

/**
 * Triggered when a new file document is created in Firestore.
 * Extracts text and structured data from the file using the configured provider.
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

    console.log(`[${new Date().toISOString()}] Starting extraction for file: ${fileData.fileName} (${fileId})`);

    try {
      const latestDoc = await db.collection("files").doc(fileId).get();
      if (latestDoc.exists && latestDoc.data()?.deletedAt) {
        console.log(`File ${fileId} was soft-deleted before extraction, skipping`);
        return;
      }

      await runExtraction(fileId, fileData, {
        skipClassification: false,
      });
    } catch (error) {
      console.error(`Extraction failed for file ${fileId}:`, error);

      // Update document with error
      await db.collection("files").doc(fileId).update({
        extractionComplete: true,
        extractionError: error instanceof Error ? error.message : "Unknown extraction error",
        updatedAt: Timestamp.now(),
      });
    }
  }
);
