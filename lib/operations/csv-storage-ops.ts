import {
  ref,
  uploadBytes,
  getDownloadURL,
  getBytes,
} from "firebase/storage";
import { storage } from "@/lib/firebase/config";

/**
 * Upload a CSV file to Firebase Storage for later re-mapping.
 *
 * @param userId - The user ID
 * @param importJobId - The import job ID (used as filename)
 * @param csvContent - The CSV file content as a string
 * @returns Storage path and download URL
 */
export async function uploadImportCSV(
  userId: string,
  importJobId: string,
  csvContent: string
): Promise<{ storagePath: string; downloadUrl: string }> {
  // Create storage path: csvImports/{userId}/{importJobId}.csv
  const storagePath = `csvImports/${userId}/${importJobId}.csv`;
  const storageRef = ref(storage, storagePath);

  // Convert string to Blob with UTF-8 encoding
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });

  // Upload the file
  await uploadBytes(storageRef, blob, {
    contentType: "text/csv",
    customMetadata: {
      importJobId,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Get download URL
  const downloadUrl = await getDownloadURL(storageRef);

  return { storagePath, downloadUrl };
}

/**
 * Download a CSV file from Firebase Storage.
 *
 * @param storagePath - The Firebase Storage path
 * @returns The CSV content as a string
 */
export async function downloadImportCSV(storagePath: string): Promise<string> {
  const storageRef = ref(storage, storagePath);

  // Download as bytes
  const bytes = await getBytes(storageRef);

  // Decode as UTF-8 text
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes);
}
