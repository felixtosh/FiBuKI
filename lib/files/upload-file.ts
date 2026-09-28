/**
 * The one way a File gets uploaded from the browser.
 *
 * Hash the bytes, look for a File with the same content, upload to storage and
 * write the File record through the `createFile` callable. The Files page and
 * the connect overlay's "Upload and connect" (#246) both call this, so a
 * dropped document becomes the same File whichever surface it was dropped on
 * (#182 is what two copies of this sequence cost last time).
 *
 * What a caller does with a duplicate is its own decision: the Files page
 * reports it, the connect overlay connects the File that already exists.
 */

import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { storage } from "@/lib/firebase/config";
import { checkFileDuplicate, createFile, OperationsContext } from "@/lib/operations";
import type { TaxFile } from "@/types/file";

export const UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const UPLOAD_ACCEPTED_TYPES: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

export type UploadResult =
  | { kind: "created"; fileId: string }
  | { kind: "duplicate"; existing: TaxFile };

/** SHA-256 of the file's bytes, hex. */
export async function contentHashOf(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function uploadFile(
  ctx: OperationsContext,
  file: File,
  opts: { onProgress?: (percent: number) => void } = {}
): Promise<UploadResult> {
  const contentHash = await contentHashOf(file);

  const existing = await checkFileDuplicate(ctx, contentHash);
  if (existing) return { kind: "duplicate", existing };

  const timestamp = Date.now();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const storagePath = `files/${ctx.userId}/${timestamp}_${sanitizedName}`;

  const storageRef = ref(storage, storagePath);
  const uploadTask = uploadBytesResumable(storageRef, file);

  await new Promise<void>((resolve, reject) => {
    uploadTask.on(
      "state_changed",
      (snapshot) => {
        opts.onProgress?.(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
      },
      (err) => reject(err),
      () => resolve()
    );
  });

  const downloadUrl = await getDownloadURL(storageRef);

  const fileId = await createFile(ctx, {
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    storagePath,
    downloadUrl,
    contentHash,
  });

  return { kind: "created", fileId };
}
