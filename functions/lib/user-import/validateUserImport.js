"use strict";
/**
 * Callable function to validate an uploaded import ZIP file.
 * Reads the manifest and validates structure without importing.
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
exports.validateUserImportCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const storage_1 = require("firebase-admin/storage");
const firestore_1 = require("firebase-admin/firestore");
const unzipper = __importStar(require("unzipper"));
const stream_1 = require("stream");
const user_export_1 = require("../types/user-export");
exports.validateUserImportCallable = (0, createCallable_1.createCallable)({
    name: "validateUserImport",
    memory: "512MiB",
    timeoutSeconds: 120,
}, async (ctx, request) => {
    const { userId, db } = ctx;
    const { uploadPath } = request;
    if (!uploadPath) {
        throw new createCallable_1.HttpsError("invalid-argument", "uploadPath is required");
    }
    // Verify the upload path belongs to this user
    if (!uploadPath.startsWith(`user-imports/${userId}/`)) {
        throw new createCallable_1.HttpsError("permission-denied", "Invalid upload path");
    }
    const storage = (0, storage_1.getStorage)();
    const bucket = storage.bucket();
    const file = bucket.file(uploadPath);
    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
        throw new createCallable_1.HttpsError("not-found", "Upload file not found");
    }
    const errors = [];
    const warnings = [];
    const counts = {};
    let manifest = null;
    let version = "unknown";
    try {
        // Download and parse ZIP
        const [content] = await file.download();
        const zipEntries = await listZipEntries(content);
        // Find manifest
        const manifestEntry = zipEntries.find((e) => e.path.endsWith("manifest.json"));
        if (!manifestEntry) {
            errors.push("Missing manifest.json in ZIP file");
        }
        else {
            try {
                const manifestContent = await extractZipEntry(content, manifestEntry.path);
                manifest = JSON.parse(manifestContent.toString("utf-8"));
                version = manifest?.version || "unknown";
                // Validate version
                if (manifest?.version !== user_export_1.EXPORT_FORMAT_VERSION) {
                    warnings.push(`Export version ${manifest?.version} differs from current version ${user_export_1.EXPORT_FORMAT_VERSION}`);
                }
                // Use counts from manifest
                if (manifest?.counts) {
                    Object.assign(counts, manifest.counts);
                }
            }
            catch (err) {
                errors.push("Invalid manifest.json format");
            }
        }
        // Check for required files
        const requiredFiles = ["sources.csv", "files.csv", "partners.csv"];
        for (const required of requiredFiles) {
            const hasFile = zipEntries.some((e) => e.path.endsWith(required));
            if (!hasFile) {
                errors.push(`Missing required file: ${required}`);
            }
        }
        // Check for transactions folder
        const hasTransactions = zipEntries.some((e) => e.path.includes("/transactions/"));
        if (!hasTransactions) {
            warnings.push("No transactions folder found in export");
        }
        // Check for storage folder if manifest says files are included
        if (manifest?.includesStorageFiles) {
            const hasStorage = zipEntries.some((e) => e.path.includes("/storage/"));
            if (!hasStorage) {
                warnings.push("Manifest indicates storage files but none found");
            }
        }
        // Count actual files in ZIP
        const csvFiles = zipEntries.filter((e) => e.path.endsWith(".csv"));
        counts.csvFiles = csvFiles.length;
        if (manifest?.includesStorageFiles) {
            const storageFiles = zipEntries.filter((e) => e.path.includes("/storage/"));
            counts.storageFilesInZip = storageFiles.length;
        }
    }
    catch (err) {
        errors.push(`Failed to read ZIP file: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
    const valid = errors.length === 0;
    // Create import record if valid
    let importId;
    if (valid) {
        const importRef = db.collection("userImports").doc();
        importId = importRef.id;
        await importRef.set({
            userId,
            status: "pending",
            uploadedZipPath: uploadPath,
            uploadedZipSize: 0, // Will be updated
            validation: {
                valid,
                version,
                counts,
                errors,
                warnings,
            },
            progress: {
                phase: "validating",
                current: 0,
                total: 0,
            },
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    return {
        valid,
        version,
        counts,
        errors,
        warnings,
        importId,
    };
});
/**
 * List all entries in a ZIP file
 */
async function listZipEntries(content) {
    const entries = [];
    return new Promise((resolve, reject) => {
        const readable = stream_1.Readable.from(content);
        readable
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
            entries.push({
                path: entry.path,
                size: entry.vars?.uncompressedSize || 0,
            });
            entry.autodrain();
        })
            .on("finish", () => resolve(entries))
            .on("error", reject);
    });
}
/**
 * Extract a single entry from a ZIP file
 */
async function extractZipEntry(content, entryPath) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const readable = stream_1.Readable.from(content);
        readable
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
            if (entry.path === entryPath) {
                entry
                    .on("data", (chunk) => chunks.push(chunk))
                    .on("end", () => resolve(Buffer.concat(chunks)));
            }
            else {
                entry.autodrain();
            }
        })
            .on("error", reject);
    });
}
//# sourceMappingURL=validateUserImport.js.map