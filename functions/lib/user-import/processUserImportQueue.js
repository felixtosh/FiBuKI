"use strict";
/**
 * Queue processor for user data imports.
 * Wipes existing data and imports from the uploaded ZIP file.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.processUserImportOnUpdate = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const unzipper = __importStar(require("unzipper"));
const stream_1 = require("stream");
const csvParsers_1 = require("./csvParsers");
const BATCH_SIZE = 500;
const PROCESSING_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
/**
 * Trigger when import status changes to "validating"
 * This indicates the user has confirmed the import
 */
exports.processUserImportOnUpdate = (0, firestore_1.onDocumentUpdated)({
    document: "userImports/{importId}",
    region: "europe-west1",
    memory: "2GiB",
    timeoutSeconds: 540, // 9 minutes
}, async (event) => {
    if (!event.data)
        return;
    const before = event.data.before.data();
    const after = event.data.after.data();
    const importId = event.params.importId;
    // Only process when transitioning to "validating" (user confirmed)
    if (before.status === "pending" && after.status === "validating") {
        await processImport(importId, after);
    }
});
/**
 * Main import processing logic
 */
async function processImport(importId, importData) {
    const db = (0, firestore_2.getFirestore)();
    const storage = (0, storage_1.getStorage)();
    const importRef = db.collection("userImports").doc(importId);
    const startTime = Date.now();
    const { userId, uploadedZipPath } = importData;
    console.log(`[processUserImport] Starting import ${importId} for user ${userId}`);
    try {
        // Download ZIP file
        const bucket = storage.bucket();
        const file = bucket.file(uploadedZipPath);
        const [zipContent] = await file.download();
        // Parse ZIP and extract files
        const zipData = await extractZipData(zipContent);
        if (!zipData.manifest) {
            throw new Error("Invalid export: missing manifest");
        }
        // Update progress: wiping
        await importRef.update({
            status: "wiping",
            "progress.phase": "wiping",
        });
        // Wipe existing user data
        await wipeUserData(db, userId, importRef, startTime);
        // Check timeout
        if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
            throw new Error("Timeout during data wipe");
        }
        // Update progress: importing
        await importRef.update({
            status: "importing",
            "progress.phase": "importing",
        });
        // Import data
        const importedCounts = await importData_(db, storage, userId, zipData, zipContent, importRef, startTime);
        // Mark as completed
        await importRef.update({
            status: "completed",
            "progress.phase": "complete",
            importedCounts,
            completedAt: firestore_2.FieldValue.serverTimestamp(),
        });
        // Create notification
        await db.collection(`users/${userId}/notifications`).add({
            type: "data_import_complete",
            title: "Data Import Complete",
            message: `Successfully imported ${importedCounts.transactions || 0} transactions, ${importedCounts.files || 0} files, and ${importedCounts.partners || 0} partners.`,
            createdAt: firestore_2.FieldValue.serverTimestamp(),
            readAt: null,
            context: {
                importId,
                importCounts: importedCounts,
            },
        });
        // Clean up uploaded ZIP
        try {
            await file.delete();
        }
        catch (err) {
            console.log(`[processUserImport] Failed to delete uploaded ZIP: ${err}`);
        }
        console.log(`[processUserImport] Completed import ${importId}`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`[processUserImport] Failed import ${importId}:`, errorMessage);
        await importRef.update({
            status: "failed",
            error: errorMessage,
            completedAt: firestore_2.FieldValue.serverTimestamp(),
        });
        // Create failure notification
        await db.collection(`users/${userId}/notifications`).add({
            type: "data_import_failed",
            title: "Data Import Failed",
            message: `Your data import failed: ${errorMessage}`,
            createdAt: firestore_2.FieldValue.serverTimestamp(),
            readAt: null,
            context: {
                importId,
            },
        });
    }
}
/**
 * Extract data from ZIP file
 */
async function extractZipData(zipContent) {
    const data = {
        manifest: null,
        userData: null,
        sourcesCsv: null,
        transactionCsvs: new Map(),
        filesCsv: null,
        fileConnectionsCsv: null,
        partnersCsv: null,
        categoriesCsv: null,
        noReceiptCategoriesCsv: null,
    };
    return new Promise((resolve, reject) => {
        const readable = stream_1.Readable.from(zipContent);
        const extractPromises = [];
        readable
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
            const path = entry.path;
            const chunks = [];
            const extractPromise = new Promise((resolveEntry) => {
                entry
                    .on("data", (chunk) => chunks.push(chunk))
                    .on("end", () => {
                    const content = Buffer.concat(chunks).toString("utf-8");
                    if (path.endsWith("manifest.json")) {
                        try {
                            data.manifest = JSON.parse(content);
                        }
                        catch { }
                    }
                    else if (path.endsWith("userData.json")) {
                        try {
                            data.userData = JSON.parse(content);
                        }
                        catch { }
                    }
                    else if (path.endsWith("sources.csv")) {
                        data.sourcesCsv = content;
                    }
                    else if (path.includes("/transactions/") && path.endsWith(".csv")) {
                        const match = path.match(/\/transactions\/([^/]+)\.csv$/);
                        if (match) {
                            data.transactionCsvs.set(match[1], content);
                        }
                    }
                    else if (path.endsWith("files.csv")) {
                        data.filesCsv = content;
                    }
                    else if (path.endsWith("fileConnections.csv")) {
                        data.fileConnectionsCsv = content;
                    }
                    else if (path.endsWith("partners.csv")) {
                        data.partnersCsv = content;
                    }
                    else if (path.endsWith("categories.csv")) {
                        data.categoriesCsv = content;
                    }
                    else if (path.endsWith("noReceiptCategories.csv")) {
                        data.noReceiptCategoriesCsv = content;
                    }
                    resolveEntry();
                });
            });
            extractPromises.push(extractPromise);
        })
            .on("finish", async () => {
            await Promise.all(extractPromises);
            resolve(data);
        })
            .on("error", reject);
    });
}
/**
 * Wipe all user data from collections
 */
async function wipeUserData(db, userId, importRef, startTime) {
    const collections = [
        "fileConnections",
        "files",
        "transactions",
        "partners",
        "categories",
        "noReceiptCategories",
        "sources",
    ];
    for (const collectionName of collections) {
        if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
            throw new Error(`Timeout during wipe of ${collectionName}`);
        }
        await importRef.update({
            "progress.currentEntity": `Deleting ${collectionName}...`,
        });
        await deleteCollection(db, collectionName, userId);
    }
    // Also delete userData
    await importRef.update({
        "progress.currentEntity": "Deleting user settings...",
    });
    await db.doc(`users/${userId}/settings/userData`).delete();
    // Delete notifications (optional, clean slate)
    await deleteSubcollection(db, `users/${userId}/notifications`);
}
/**
 * Delete all documents in a collection for a user
 */
async function deleteCollection(db, collectionName, userId) {
    let deleted = 0;
    while (true) {
        const snapshot = await db
            .collection(collectionName)
            .where("userId", "==", userId)
            .limit(BATCH_SIZE)
            .get();
        if (snapshot.empty)
            break;
        const batch = db.batch();
        for (const doc of snapshot.docs) {
            batch.delete(doc.ref);
        }
        await batch.commit();
        deleted += snapshot.size;
        console.log(`[processUserImport] Deleted ${deleted} ${collectionName}`);
    }
}
/**
 * Delete all documents in a subcollection
 */
async function deleteSubcollection(db, path) {
    while (true) {
        const snapshot = await db.collection(path).limit(BATCH_SIZE).get();
        if (snapshot.empty)
            break;
        const batch = db.batch();
        for (const doc of snapshot.docs) {
            batch.delete(doc.ref);
        }
        await batch.commit();
    }
}
/**
 * Import data from ZIP
 */
async function importData_(db, storage, userId, zipData, zipContent, importRef, startTime) {
    const counts = {
        sources: 0,
        transactions: 0,
        files: 0,
        fileConnections: 0,
        partners: 0,
        categories: 0,
        noReceiptCategories: 0,
    };
    // Import sources first
    if (zipData.sourcesCsv) {
        await importRef.update({ "progress.currentEntity": "Importing sources..." });
        const sources = (0, csvParsers_1.parseCsv)(zipData.sourcesCsv);
        counts.sources = await importDocuments(db, "sources", sources, userId);
    }
    // Import transactions
    for (const [fileName, csv] of zipData.transactionCsvs) {
        if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
            throw new Error("Timeout during transaction import");
        }
        await importRef.update({
            "progress.currentEntity": `Importing transactions (${fileName})...`,
        });
        const transactions = (0, csvParsers_1.parseCsv)(csv);
        counts.transactions += await importDocuments(db, "transactions", transactions, userId);
    }
    // Import files
    if (zipData.filesCsv) {
        await importRef.update({ "progress.currentEntity": "Importing files..." });
        const files = (0, csvParsers_1.parseCsv)(zipData.filesCsv);
        counts.files = await importDocuments(db, "files", files, userId);
    }
    // Import file connections
    if (zipData.fileConnectionsCsv) {
        await importRef.update({ "progress.currentEntity": "Importing file connections..." });
        const connections = (0, csvParsers_1.parseCsv)(zipData.fileConnectionsCsv);
        counts.fileConnections = await importDocuments(db, "fileConnections", connections, userId);
    }
    // Import partners
    if (zipData.partnersCsv) {
        await importRef.update({ "progress.currentEntity": "Importing partners..." });
        const partners = (0, csvParsers_1.parseCsv)(zipData.partnersCsv);
        counts.partners = await importDocuments(db, "partners", partners, userId);
    }
    // Import categories
    if (zipData.categoriesCsv) {
        await importRef.update({ "progress.currentEntity": "Importing categories..." });
        const categories = (0, csvParsers_1.parseCsv)(zipData.categoriesCsv);
        counts.categories = await importDocuments(db, "categories", categories, userId);
    }
    // Import no-receipt categories
    if (zipData.noReceiptCategoriesCsv) {
        await importRef.update({ "progress.currentEntity": "Importing no-receipt categories..." });
        const noReceiptCategories = (0, csvParsers_1.parseCsv)(zipData.noReceiptCategoriesCsv);
        counts.noReceiptCategories = await importDocuments(db, "noReceiptCategories", noReceiptCategories, userId);
    }
    // Import user data
    if (zipData.userData) {
        await importRef.update({ "progress.currentEntity": "Importing user settings..." });
        await db.doc(`users/${userId}/settings/userData`).set({
            ...zipData.userData,
            updatedAt: firestore_2.FieldValue.serverTimestamp(),
        });
    }
    // Import storage files if included
    if (zipData.manifest?.includesStorageFiles) {
        await importRef.update({ "progress.currentEntity": "Importing storage files..." });
        const storageCount = await importStorageFiles(storage, userId, zipContent, importRef);
        counts.storageFiles = storageCount;
    }
    return counts;
}
/**
 * Import documents in batches
 */
async function importDocuments(db, collectionName, documents, userId) {
    let imported = 0;
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = documents.slice(i, i + BATCH_SIZE);
        for (const doc of chunk) {
            const id = doc.id;
            if (!id)
                continue;
            const prepared = (0, csvParsers_1.prepareDocForImport)(doc, userId);
            const ref = db.collection(collectionName).doc(id);
            batch.set(ref, prepared);
            imported++;
        }
        await batch.commit();
    }
    console.log(`[processUserImport] Imported ${imported} ${collectionName}`);
    return imported;
}
/**
 * Import storage files from ZIP
 */
async function importStorageFiles(storage, userId, zipContent, importRef) {
    const bucket = storage.bucket();
    let imported = 0;
    return new Promise((resolve, reject) => {
        const readable = stream_1.Readable.from(zipContent);
        const uploadPromises = [];
        readable
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
            const path = entry.path;
            // Only process storage files
            if (!path.includes("/storage/")) {
                entry.autodrain();
                return;
            }
            const chunks = [];
            const uploadPromise = new Promise((resolveUpload) => {
                entry
                    .on("data", (chunk) => chunks.push(chunk))
                    .on("end", async () => {
                    try {
                        const content = Buffer.concat(chunks);
                        // Extract relative path
                        const match = path.match(/\/storage\/(.+)$/);
                        if (match) {
                            const relativePath = match[1];
                            const storagePath = `files/${userId}/${relativePath}`;
                            const file = bucket.file(storagePath);
                            await file.save(content, {
                                metadata: {
                                    metadata: {
                                        importedAt: new Date().toISOString(),
                                    },
                                },
                            });
                            imported++;
                            if (imported % 10 === 0) {
                                await importRef.update({
                                    "progress.currentEntity": `Importing storage files (${imported})...`,
                                });
                            }
                        }
                    }
                    catch (err) {
                        console.error(`[processUserImport] Failed to upload ${path}:`, err);
                    }
                    resolveUpload();
                });
            });
            uploadPromises.push(uploadPromise);
        })
            .on("finish", async () => {
            await Promise.all(uploadPromises);
            resolve(imported);
        })
            .on("error", reject);
    });
}
//# sourceMappingURL=processUserImportQueue.js.map