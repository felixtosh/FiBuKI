/**
 * Queue processor for user data exports.
 * Triggers on document creation in userExports collection.
 * Collects all user data, generates CSVs, creates ZIP, and uploads to Storage.
 */

import {
  onDocumentCreated,
  FirestoreEvent,
  QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import archiver from "archiver";
import { PassThrough } from "stream";

import {
  UserExport,
  ExportManifest,
  EXPORT_FORMAT_VERSION,
  EXPORT_EXPIRY_DAYS,
} from "../types/user-export";
import {
  generateCsv,
  sourcesColumns,
  transactionsColumns,
  filesColumns,
  partnersColumns,
  categoriesColumns,
  noReceiptCategoriesColumns,
  fileConnectionsColumns,
} from "./csvGenerators";

const PROCESSING_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (leaving 1 min buffer)

/**
 * Trigger: Process export when document is created
 */
export const processUserExportOnCreate = onDocumentCreated(
  {
    document: "userExports/{exportId}",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 540, // 9 minutes
  },
  async (event: FirestoreEvent<QueryDocumentSnapshot | undefined>) => {
    if (!event.data) return;

    const exportId = event.params.exportId;
    const exportData = event.data.data() as Omit<UserExport, "id">;

    // Only process pending exports
    if (exportData.status !== "pending") {
      console.log(`[processUserExport] Skipping ${exportId}, status: ${exportData.status}`);
      return;
    }

    await processExport(exportId, exportData);
  }
);

/**
 * Scheduled: Retry failed/stalled exports
 */
export const processUserExportScheduled = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();

    // Find pending or stalled processing exports
    const stalledThreshold = Timestamp.fromDate(
      new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
    );

    const pendingExports = await db
      .collection("userExports")
      .where("status", "in", ["pending", "processing"])
      .limit(5)
      .get();

    for (const doc of pendingExports.docs) {
      const exportData = doc.data() as Omit<UserExport, "id">;

      // Skip if recently started
      if (
        exportData.status === "processing" &&
        exportData.startedAt &&
        (exportData.startedAt as Timestamp).toMillis() > stalledThreshold.toMillis()
      ) {
        continue;
      }

      console.log(`[processUserExport] Scheduled processing ${doc.id}`);
      await processExport(doc.id, exportData);
    }
  }
);

/**
 * Main export processing logic
 */
async function processExport(
  exportId: string,
  exportData: Omit<UserExport, "id">
): Promise<void> {
  const db = getFirestore();
  const storage = getStorage();
  const exportRef = db.collection("userExports").doc(exportId);
  const startTime = Date.now();

  const { userId, includeStorageFiles } = exportData;

  console.log(`[processUserExport] Starting export ${exportId} for user ${userId}`);

  try {
    // Mark as processing
    await exportRef.update({
      status: "processing",
      startedAt: FieldValue.serverTimestamp(),
      "progress.phase": "collecting",
    });

    // Collect all user data
    const data = await collectUserData(db, userId, exportRef, startTime);

    // Check timeout
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      throw new Error("Timeout during data collection");
    }

    // Update progress
    await exportRef.update({
      "progress.phase": "packaging",
      counts: data.counts,
    });

    // Create ZIP in memory
    const zipBuffer = await createExportZip(
      data,
      exportId,
      userId,
      includeStorageFiles,
      storage,
      exportRef,
      startTime
    );

    // Check timeout
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      throw new Error("Timeout during ZIP creation");
    }

    // Update progress
    await exportRef.update({
      "progress.phase": "uploading",
    });

    // Upload to Storage
    const storagePath = `user-exports/${userId}/${exportId}/export.zip`;
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);

    // Generate a download token
    const downloadToken = crypto.randomUUID();

    await file.save(zipBuffer, {
      contentType: "application/zip",
      metadata: {
        metadata: {
          userId,
          exportId,
          createdAt: new Date().toISOString(),
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });

    // Generate download URL with token (works for both emulator and production)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + EXPORT_EXPIRY_DAYS);

    const encodedPath = encodeURIComponent(storagePath);
    const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    let downloadUrl: string;

    if (storageEmulatorHost) {
      // Emulator URL format
      downloadUrl = `http://${storageEmulatorHost}/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
    } else {
      // Production URL format
      downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
    }

    // Mark as completed
    await exportRef.update({
      status: "completed",
      "progress.phase": "complete",
      downloadUrl,
      storagePath,
      zipSize: zipBuffer.length,
      expiresAt: Timestamp.fromDate(expiresAt),
      completedAt: FieldValue.serverTimestamp(),
    });

    // Create notification
    await db.collection(`users/${userId}/notifications`).add({
      type: "export_complete",
      title: "Data Export Ready",
      message: `Your data export is ready for download. It will expire in ${EXPORT_EXPIRY_DAYS} days.`,
      createdAt: FieldValue.serverTimestamp(),
      readAt: null,
      context: {
        exportId,
        downloadUrl,
        expiresAt: expiresAt.toISOString(),
        zipSize: zipBuffer.length,
        exportCounts: data.counts,
      },
    });

    console.log(`[processUserExport] Completed export ${exportId}, size: ${zipBuffer.length} bytes`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[processUserExport] Failed export ${exportId}:`, errorMessage);

    const currentRetry = exportData.retryCount || 0;
    const maxRetries = exportData.maxRetries || 3;

    if (currentRetry < maxRetries && errorMessage.includes("Timeout")) {
      // Retry on timeout
      await exportRef.update({
        status: "pending",
        retryCount: currentRetry + 1,
        error: errorMessage,
      });
    } else {
      // Mark as failed
      await exportRef.update({
        status: "failed",
        error: errorMessage,
        completedAt: FieldValue.serverTimestamp(),
      });

      // Create failure notification
      await db.collection(`users/${userId}/notifications`).add({
        type: "export_failed",
        title: "Data Export Failed",
        message: `Your data export failed: ${errorMessage}`,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null,
        context: {
          exportId,
        },
      });
    }
  }
}

/**
 * Collect all user data from Firestore
 */
async function collectUserData(
  db: FirebaseFirestore.Firestore,
  userId: string,
  exportRef: FirebaseFirestore.DocumentReference,
  startTime: number
): Promise<CollectedData> {
  const data: CollectedData = {
    sources: [],
    transactionsBySource: {},
    files: [],
    partners: [],
    categories: [],
    noReceiptCategories: [],
    fileConnections: [],
    userData: null,
    counts: {
      sources: 0,
      transactions: 0,
      files: 0,
      partners: 0,
      categories: 0,
      noReceiptCategories: 0,
      fileConnections: 0,
    },
  };

  // Collect sources
  await exportRef.update({ "progress.currentEntity": "sources" });
  const sourcesSnap = await db
    .collection("sources")
    .where("userId", "==", userId)
    .get();
  data.sources = sourcesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  data.counts.sources = data.sources.length;

  // Collect transactions per source
  let totalTransactions = 0;
  for (const source of data.sources) {
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      throw new Error("Timeout during transaction collection");
    }

    await exportRef.update({
      "progress.currentEntity": `transactions (${source.name})`,
      "progress.current": totalTransactions,
    });

    const transactionsSnap = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("sourceId", "==", source.id)
      .get();

    data.transactionsBySource[source.id as string] = transactionsSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    totalTransactions += transactionsSnap.size;
  }
  data.counts.transactions = totalTransactions;

  // Collect files
  await exportRef.update({ "progress.currentEntity": "files" });
  const filesSnap = await db
    .collection("files")
    .where("userId", "==", userId)
    .get();
  data.files = filesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  data.counts.files = data.files.length;

  // Collect file connections
  await exportRef.update({ "progress.currentEntity": "fileConnections" });
  const fileConnectionsSnap = await db
    .collection("fileConnections")
    .where("userId", "==", userId)
    .get();
  data.fileConnections = fileConnectionsSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  data.counts.fileConnections = data.fileConnections.length;

  // Collect partners
  await exportRef.update({ "progress.currentEntity": "partners" });
  const partnersSnap = await db
    .collection("partners")
    .where("userId", "==", userId)
    .get();
  data.partners = partnersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  data.counts.partners = data.partners.length;

  // Collect categories (user-specific only)
  await exportRef.update({ "progress.currentEntity": "categories" });
  const categoriesSnap = await db
    .collection("categories")
    .where("userId", "==", userId)
    .get();
  data.categories = categoriesSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  data.counts.categories = data.categories.length;

  // Collect no-receipt categories
  await exportRef.update({ "progress.currentEntity": "noReceiptCategories" });
  const noReceiptCategoriesSnap = await db
    .collection("noReceiptCategories")
    .where("userId", "==", userId)
    .get();
  data.noReceiptCategories = noReceiptCategoriesSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  data.counts.noReceiptCategories = data.noReceiptCategories.length;

  // Collect user data
  await exportRef.update({ "progress.currentEntity": "userData" });
  const userDataSnap = await db
    .doc(`users/${userId}/settings/userData`)
    .get();
  if (userDataSnap.exists) {
    data.userData = userDataSnap.data() || null;
  }

  return data;
}

interface CollectedData {
  sources: Record<string, unknown>[];
  transactionsBySource: Record<string, Record<string, unknown>[]>;
  files: Record<string, unknown>[];
  partners: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  noReceiptCategories: Record<string, unknown>[];
  fileConnections: Record<string, unknown>[];
  userData: Record<string, unknown> | null;
  counts: {
    sources: number;
    transactions: number;
    files: number;
    partners: number;
    categories: number;
    noReceiptCategories: number;
    fileConnections: number;
    storageFiles?: number;
    storageSize?: number;
  };
}

/**
 * Create the export ZIP file
 */
async function createExportZip(
  data: CollectedData,
  exportId: string,
  userId: string,
  includeStorageFiles: boolean,
  storage: ReturnType<typeof getStorage>,
  exportRef: FirebaseFirestore.DocumentReference,
  startTime: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passThrough = new PassThrough();

    passThrough.on("data", (chunk: Buffer) => chunks.push(chunk));
    passThrough.on("end", () => resolve(Buffer.concat(chunks)));
    passThrough.on("error", reject);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    archive.pipe(passThrough);

    const exportDate = new Date().toISOString().split("T")[0];
    const folderName = `fibuki-export-${exportDate}`;

    // Add manifest
    const manifest: ExportManifest = {
      version: EXPORT_FORMAT_VERSION,
      exportDate: new Date().toISOString(),
      userId,
      exportId,
      includesStorageFiles: includeStorageFiles,
      counts: data.counts,
    };
    archive.append(JSON.stringify(manifest, null, 2), {
      name: `${folderName}/manifest.json`,
    });

    // Add userData
    if (data.userData) {
      archive.append(JSON.stringify(data.userData, null, 2), {
        name: `${folderName}/userData.json`,
      });
    }

    // Add sources CSV
    const sourcesCsv = generateCsv(data.sources, sourcesColumns);
    archive.append(sourcesCsv, { name: `${folderName}/sources.csv` });

    // Add transactions CSVs (one per source)
    for (const source of data.sources) {
      const sourceId = source.id as string;
      const sourceName = (source.name as string || "unnamed").replace(/[^a-zA-Z0-9-_]/g, "_");
      const transactions = data.transactionsBySource[sourceId] || [];
      if (transactions.length > 0) {
        const transactionsCsv = generateCsv(transactions, transactionsColumns);
        archive.append(transactionsCsv, {
          name: `${folderName}/transactions/${sourceId}-${sourceName}.csv`,
        });
      }
    }

    // Add files CSV
    const filesCsv = generateCsv(data.files, filesColumns);
    archive.append(filesCsv, { name: `${folderName}/files.csv` });

    // Add file connections CSV
    const fileConnectionsCsv = generateCsv(data.fileConnections, fileConnectionsColumns);
    archive.append(fileConnectionsCsv, { name: `${folderName}/fileConnections.csv` });

    // Add partners CSV
    const partnersCsv = generateCsv(data.partners, partnersColumns);
    archive.append(partnersCsv, { name: `${folderName}/partners.csv` });

    // Add categories CSV
    const categoriesCsv = generateCsv(data.categories, categoriesColumns);
    archive.append(categoriesCsv, { name: `${folderName}/categories.csv` });

    // Add no-receipt categories CSV
    const noReceiptCategoriesCsv = generateCsv(
      data.noReceiptCategories,
      noReceiptCategoriesColumns
    );
    archive.append(noReceiptCategoriesCsv, {
      name: `${folderName}/noReceiptCategories.csv`,
    });

    // Handle storage files if requested
    if (includeStorageFiles && data.files.length > 0) {
      // Add storage files asynchronously
      addStorageFiles(
        archive,
        data.files,
        folderName,
        storage,
        exportRef,
        startTime
      )
        .then(() => {
          archive.finalize();
        })
        .catch(reject);
    } else {
      archive.finalize();
    }
  });
}

/**
 * Add actual storage files to the ZIP
 */
async function addStorageFiles(
  archive: archiver.Archiver,
  files: Record<string, unknown>[],
  folderName: string,
  storage: ReturnType<typeof getStorage>,
  exportRef: FirebaseFirestore.DocumentReference,
  startTime: number
): Promise<void> {
  const bucket = storage.bucket();
  let filesAdded = 0;
  let totalSize = 0;

  for (const file of files) {
    // Check timeout
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      console.log(`[processUserExport] Timeout after ${filesAdded} storage files`);
      break;
    }

    const storagePath = file.storagePath as string;
    if (!storagePath) continue;

    try {
      const storageFile = bucket.file(storagePath);
      const [exists] = await storageFile.exists();

      if (exists) {
        const [metadata] = await storageFile.getMetadata();
        const fileSize = parseInt(metadata.size as string, 10) || 0;

        // Skip very large files (> 50MB)
        if (fileSize > 50 * 1024 * 1024) {
          console.log(`[processUserExport] Skipping large file: ${storagePath}`);
          continue;
        }

        const [content] = await storageFile.download();

        // Use relative path in storage folder
        const relativePath = storagePath.replace(/^files\/[^/]+\//, "");
        archive.append(content, {
          name: `${folderName}/storage/${relativePath}`,
        });

        filesAdded++;
        totalSize += fileSize;

        // Update progress periodically
        if (filesAdded % 10 === 0) {
          await exportRef.update({
            "progress.currentEntity": `storage files (${filesAdded}/${files.length})`,
            "counts.storageFiles": filesAdded,
            "counts.storageSize": totalSize,
          });
        }
      }
    } catch (err) {
      console.error(`[processUserExport] Failed to add file ${storagePath}:`, err);
    }
  }

  await exportRef.update({
    "counts.storageFiles": filesAdded,
    "counts.storageSize": totalSize,
  });
}
