/**
 * Callable function to validate an uploaded import ZIP file.
 * Reads the manifest and validates structure without importing.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import * as unzipper from "unzipper";
import { Readable } from "stream";

import {
  ValidateUserImportRequest,
  ImportValidation,
  ExportManifest,
  EXPORT_FORMAT_VERSION,
} from "../types/user-export";

interface ValidationResult extends ImportValidation {
  importId?: string;
}

export const validateUserImportCallable = createCallable<
  ValidateUserImportRequest,
  ValidationResult
>(
  {
    name: "validateUserImport",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (ctx, request) => {
    const { userId, db } = ctx;
    const { uploadPath } = request;

    if (!uploadPath) {
      throw new HttpsError("invalid-argument", "uploadPath is required");
    }

    // Verify the upload path belongs to this user
    if (!uploadPath.startsWith(`user-imports/${userId}/`)) {
      throw new HttpsError("permission-denied", "Invalid upload path");
    }

    const storage = getStorage();
    const bucket = storage.bucket();
    const file = bucket.file(uploadPath);

    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      throw new HttpsError("not-found", "Upload file not found");
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const counts: Record<string, number> = {};
    let manifest: ExportManifest | null = null;
    let version = "unknown";

    try {
      // Download and parse ZIP
      const [content] = await file.download();
      const zipEntries = await listZipEntries(content);

      // Find manifest
      const manifestEntry = zipEntries.find((e) => e.path.endsWith("manifest.json"));
      if (!manifestEntry) {
        errors.push("Missing manifest.json in ZIP file");
      } else {
        try {
          const manifestContent = await extractZipEntry(content, manifestEntry.path);
          manifest = JSON.parse(manifestContent.toString("utf-8"));
          version = manifest?.version || "unknown";

          // Validate version
          if (manifest?.version !== EXPORT_FORMAT_VERSION) {
            warnings.push(
              `Export version ${manifest?.version} differs from current version ${EXPORT_FORMAT_VERSION}`
            );
          }

          // Use counts from manifest
          if (manifest?.counts) {
            Object.assign(counts, manifest.counts);
          }
        } catch (err) {
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
    } catch (err) {
      errors.push(`Failed to read ZIP file: ${err instanceof Error ? err.message : "Unknown error"}`);
    }

    const valid = errors.length === 0;

    // Create import record if valid
    let importId: string | undefined;
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
        createdAt: FieldValue.serverTimestamp(),
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
  }
);

/**
 * List all entries in a ZIP file
 */
async function listZipEntries(
  content: Buffer
): Promise<Array<{ path: string; size: number }>> {
  const entries: Array<{ path: string; size: number }> = [];

  return new Promise((resolve, reject) => {
    const readable = Readable.from(content);
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
async function extractZipEntry(content: Buffer, entryPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const readable = Readable.from(content);

    readable
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        if (entry.path === entryPath) {
          entry
            .on("data", (chunk: Buffer) => chunks.push(chunk))
            .on("end", () => resolve(Buffer.concat(chunks)));
        } else {
          entry.autodrain();
        }
      })
      .on("error", reject);
  });
}
