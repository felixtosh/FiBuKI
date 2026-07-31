/**
 * Queue processor for BMD NTCS exports.
 * Triggers on document creation in bmdExports collection.
 * Collects transactions with files, generates BMD CSVs, creates ZIP, and uploads to Storage.
 */

import {
  onDocumentCreated,
  FirestoreEvent,
  QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import archiver from "archiver";
import { PassThrough } from "stream";

import {
  BmdExport,
  BmdExportManifest,
  BMD_EXPORT_FORMAT_VERSION,
  BMD_EXPORT_EXPIRY_DAYS,
} from "../types/bmd-export";
import {
  generatePersonenkontenCsv,
  generateBuchungenCsv,
  PartnerForExport,
  TransactionForExport,
  FileForExport,
  PartnerAccountIndex,
} from "./bmdCsvGenerators";

const PROCESSING_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Trigger: Process BMD export when document is created
 */
export const processBmdExportOnCreate = onDocumentCreated(
  {
    document: "bmdExports/{exportId}",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 540, // 9 minutes
  },
  async (event: FirestoreEvent<QueryDocumentSnapshot | undefined>) => {
    if (!event.data) return;

    const exportId = event.params.exportId;
    const exportData = event.data.data() as Omit<BmdExport, "id">;

    // Only process pending exports
    if (exportData.status !== "pending") {
      console.log(
        `[processBmdExport] Skipping ${exportId}, status: ${exportData.status}`
      );
      return;
    }

    await processBmdExport(exportId, exportData);
  }
);

/**
 * Main BMD export processing logic
 */
async function processBmdExport(
  exportId: string,
  exportData: Omit<BmdExport, "id">
): Promise<void> {
  const db = getFirestore();
  const storage = getStorage();
  const exportRef = db.collection("bmdExports").doc(exportId);
  const startTime = Date.now();

  const { userId, dateFrom, dateTo, onlyWithFiles, includeFiles } = exportData;

  console.log(
    `[processBmdExport] Starting export ${exportId} for user ${userId}`
  );

  try {
    // Mark as processing
    await exportRef.update({
      status: "processing",
      startedAt: FieldValue.serverTimestamp(),
      "progress.phase": "collecting",
    });

    // 1. Collect transactions in date range
    await exportRef.update({ "progress.currentEntity": "transactions" });

    const txQuery = db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("date", ">=", dateFrom)
      .where("date", "<=", dateTo);

    interface TransactionDoc {
      id: string;
      date: Timestamp;
      amount: number;
      name?: string;
      partner?: string;
      partnerId?: string;
      fileIds?: string[];
      vatRate?: number;
      vatAmount?: number;
      vatId?: string;
      noReceiptCategoryId?: string | null;
      noReceiptCategoryTemplateId?: string | null;
    }

    const txSnapshot = await txQuery.get();
    let transactions: TransactionDoc[] = txSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<TransactionDoc, "id">),
    }));

    // Filter to only complete transactions (files OR no-receipt category)
    if (onlyWithFiles) {
      transactions = transactions.filter((tx) => {
        const hasFiles = tx.fileIds && Array.isArray(tx.fileIds) && tx.fileIds.length > 0;
        const hasCategory = !!tx.noReceiptCategoryId;
        return hasFiles || hasCategory;
      });
    }

    await exportRef.update({
      "counts.transactions": transactions.length,
      "progress.currentEntity": "files",
    });

    // 2. Collect all connected files
    const allFileIds = new Set<string>();
    transactions.forEach((tx) => {
      const fileIds = tx.fileIds as string[] | undefined;
      if (fileIds) {
        fileIds.forEach((fid) => allFileIds.add(fid));
      }
    });

    const filesMap = new Map<string, FileForExport & { storagePath?: string }>();
    for (const fileId of allFileIds) {
      const fileDoc = await db.collection("files").doc(fileId).get();
      if (fileDoc.exists) {
        const data = fileDoc.data();
        filesMap.set(fileId, {
          id: fileId,
          fileName: data?.fileName || "document",
          extractedDate: data?.extractedDate,
          storagePath: data?.storagePath,
        });
      }
    }

    await exportRef.update({
      "counts.files": filesMap.size,
      "progress.currentEntity": "partners",
    });

    // 3. Collect all associated partners
    const partnerIds = new Set<string>();
    transactions.forEach((tx) => {
      if (tx.partnerId) partnerIds.add(tx.partnerId as string);
    });

    const partnersMap = new Map<string, Record<string, unknown>>();
    for (const partnerId of partnerIds) {
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      if (partnerDoc.exists) {
        partnersMap.set(partnerId, { id: partnerId, ...partnerDoc.data() });
      }
    }

    // Determine Kreditor vs Debitor for each partner based on transaction amounts
    const partnerTypes = new Map<string, "kreditor" | "debitor">();
    transactions.forEach((tx) => {
      if (tx.partnerId) {
        const isExpense = (tx.amount as number) < 0;
        partnerTypes.set(tx.partnerId as string, isExpense ? "kreditor" : "debitor");
      }
    });

    // Prepare partners for export
    const partnersForExport: PartnerForExport[] = Array.from(
      partnersMap.values()
    ).map((p) => ({
      id: p.id as string,
      name: p.name as string | undefined,
      street: p.street as string | undefined,
      postalCode: p.postalCode as string | undefined,
      city: p.city as string | undefined,
      country: p.country as string | undefined,
      vatId: p.vatId as string | undefined,
      ibans: p.ibans as string[] | undefined,
      isKreditor: partnerTypes.get(p.id as string) === "kreditor",
    }));

    const kreditorenCount = partnersForExport.filter((p) => p.isKreditor).length;
    const debitorenCount = partnersForExport.filter((p) => !p.isKreditor).length;

    await exportRef.update({
      "counts.partners": partnersMap.size,
      "counts.kreditoren": kreditorenCount,
      "counts.debitoren": debitorenCount,
      "progress.phase": "generating",
    });

    // Check timeout
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      throw new Error("Timeout during data collection");
    }

    // 4. Generate BMD CSVs
    const partnerIndex: PartnerAccountIndex = new Map();

    const personenkontenCsv = generatePersonenkontenCsv(
      partnersForExport,
      partnerIndex
    );

    // Prepare transactions for CSV generation
    const transactionsForExport: TransactionForExport[] = transactions.map(
      (tx) => ({
        id: tx.id,
        date: tx.date as Timestamp,
        amount: tx.amount as number,
        name: tx.name as string | undefined,
        partner: tx.partner as string | undefined,
        partnerName: tx.partnerId
          ? (partnersMap.get(tx.partnerId)?.name as string | undefined)
          : undefined,
        partnerId: tx.partnerId as string | undefined,
        fileIds: tx.fileIds as string[] | undefined,
        vatRate: tx.vatRate as number | undefined,
        vatAmount: tx.vatAmount as number | undefined,
        vatId: tx.vatId as string | undefined,
        noReceiptCategoryId: tx.noReceiptCategoryId,
        noReceiptCategoryTemplateId: tx.noReceiptCategoryTemplateId,
      })
    );

    // Convert filesMap to simple FileForExport map
    const simpleFilesMap = new Map<string, FileForExport>();
    filesMap.forEach((file, id) => {
      simpleFilesMap.set(id, {
        id: file.id,
        fileName: file.fileName,
        extractedDate: file.extractedDate,
      });
    });

    const buchungenCsv = generateBuchungenCsv(
      transactionsForExport,
      simpleFilesMap,
      partnerIndex
    );

    await exportRef.update({
      "progress.phase": "packaging",
    });

    // 5. Create ZIP
    const zipBuffer = await createBmdZip(
      personenkontenCsv,
      buchungenCsv,
      filesMap,
      includeFiles,
      storage,
      exportRef,
      exportId,
      userId,
      dateFrom,
      dateTo,
      {
        transactions: transactions.length,
        files: filesMap.size,
        partners: partnersMap.size,
        kreditoren: kreditorenCount,
        debitoren: debitorenCount,
      }
    );

    // Check timeout
    if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
      throw new Error("Timeout during ZIP creation");
    }

    await exportRef.update({
      "progress.phase": "uploading",
    });

    // 6. Upload to Storage
    const exportDate = new Date().toISOString().split("T")[0];
    const storagePath = `bmd-exports/${userId}/${exportId}/fibuki-bmd-export-${exportDate}.zip`;
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
          format: "BMD-NTCS",
          createdAt: new Date().toISOString(),
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });

    // Generate download URL
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + BMD_EXPORT_EXPIRY_DAYS);

    const downloadUrl = buildDownloadUrl(bucket.name, storagePath, downloadToken);

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

    console.log(
      `[processBmdExport] Completed export ${exportId}, size: ${zipBuffer.length} bytes, ${transactions.length} transactions`
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[processBmdExport] Failed export ${exportId}:`, errorMessage);

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
    }
  }
}

/**
 * Create the BMD export ZIP file
 */
async function createBmdZip(
  personenkontenCsv: string,
  buchungenCsv: string,
  filesMap: Map<string, FileForExport & { storagePath?: string }>,
  includeFiles: boolean,
  storage: ReturnType<typeof getStorage>,
  exportRef: FirebaseFirestore.DocumentReference,
  exportId: string,
  userId: string,
  dateFrom: Timestamp,
  dateTo: Timestamp,
  counts: {
    transactions: number;
    files: number;
    partners: number;
    kreditoren: number;
    debitoren: number;
  }
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

    // Add manifest
    const manifest: BmdExportManifest = {
      version: BMD_EXPORT_FORMAT_VERSION,
      format: "BMD-NTCS",
      exportDate: new Date().toISOString(),
      userId,
      exportId,
      dateRange: {
        from: dateFrom.toDate().toISOString().split("T")[0],
        to: dateTo.toDate().toISOString().split("T")[0],
      },
      counts,
      includesFiles: includeFiles,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    // Add CSVs with UTF-8 BOM for Excel compatibility
    const BOM = "\ufeff";
    archive.append(BOM + personenkontenCsv, { name: "personenkonten.csv" });
    archive.append(BOM + buchungenCsv, { name: "buchungen.csv" });

    if (includeFiles && filesMap.size > 0) {
      // Add receipt files asynchronously
      addReceiptFiles(archive, filesMap, storage, exportRef)
        .then(() => archive.finalize())
        .catch(reject);
    } else {
      archive.finalize();
    }
  });
}

/**
 * Add receipt files to the ZIP archive
 */
async function addReceiptFiles(
  archive: archiver.Archiver,
  filesMap: Map<string, FileForExport & { storagePath?: string }>,
  storage: ReturnType<typeof getStorage>,
  exportRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  const bucket = storage.bucket();
  let filesAdded = 0;

  for (const [fileId, fileData] of filesMap) {
    const storagePath = fileData.storagePath;
    if (!storagePath) continue;

    try {
      const storageFile = bucket.file(storagePath);
      const [exists] = await storageFile.exists();

      if (exists) {
        const [metadata] = await storageFile.getMetadata();
        const fileSize = parseInt(metadata.size as string, 10) || 0;

        // Skip very large files (> 50MB)
        if (fileSize > 50 * 1024 * 1024) {
          console.log(`[processBmdExport] Skipping large file: ${storagePath}`);
          continue;
        }

        const [content] = await storageFile.download();

        // Use sanitized filename
        const safeName = fileData.fileName
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .substring(0, 100);

        archive.append(content, { name: `belege/${fileId}_${safeName}` });
        filesAdded++;

        if (filesAdded % 10 === 0) {
          await exportRef.update({
            "progress.currentEntity": `files (${filesAdded}/${filesMap.size})`,
          });
        }
      }
    } catch (err) {
      console.error(`[processBmdExport] Failed to add file ${storagePath}:`, err);
    }
  }

  console.log(`[processBmdExport] Added ${filesAdded} receipt files to ZIP`);
}
