export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { createHash, randomUUID } from "crypto";
import { getAdminDb, getAdminBucket, getFirebaseStorageDownloadUrl } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import {
  createFileRecord,
  findFileByContentHash,
} from "@/functions/src/files/createFileRecord";

const db = getAdminDb();
const FILES_COLLECTION = "files";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.-]/g, "_");
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * POST /api/browser/upload
 * Save an invoice file collected by the browser extension.
 *
 * FormData:
 * - file: Blob
 * - sourceUrl: string
 * - sourceRunId: string
 * - sourceCollectorId?: string
 * - transactionId?: string (when provided, auto-connects the uploaded file)
 *
 * Writes through `createFileRecord`, so a re-collect of bytes already on file
 * answers with the existing File and `duplicate: true` rather than a second
 * record (#182).
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const formData = await request.formData();
    const file = formData.get("file");
    const sourceUrl = formData.get("sourceUrl");
    const sourceRunId = formData.get("sourceRunId");
    const sourceCollectorId = formData.get("sourceCollectorId");
    const transactionId = formData.get("transactionId");

    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    if (typeof sourceUrl !== "string" || typeof sourceRunId !== "string") {
      return NextResponse.json(
        { error: "sourceUrl and sourceRunId are required" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/pdf";
    const originalName = (file as File).name || "invoice.pdf";
    const sanitizedFilename = sanitizeFilename(originalName);

    // Hash the bytes before touching storage (#182). This route computed a
    // contentHash and then wrote `files` directly, so a re-collect of the same
    // invoice landed a second File the guard at the write point never saw.
    // Asking that write point's own lookup here saves re-uploading bytes we
    // already hold; createFileRecord below is what refuses the duplicate.
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const alreadyOnFile = await findFileByContentHash(db, userId, contentHash);

    let fileId: string;
    let downloadUrl: string;
    let duplicate: boolean;

    if (alreadyOnFile) {
      fileId = alreadyOnFile.id;
      downloadUrl = (alreadyOnFile.data().downloadUrl as string | undefined) ?? "";
      duplicate = true;
    } else {
      const timestamp = Date.now();
      const storagePath = `files/${userId}/${timestamp}_${sanitizedFilename}`;

      // Upload to Firebase Storage using Admin SDK
      const bucket = getAdminBucket();
      const storageFile = bucket.file(storagePath);

      // Generate a download token (same as client SDK's getDownloadURL)
      const downloadToken = randomUUID();

      await storageFile.save(buffer, {
        metadata: {
          contentType: mimeType,
          contentDisposition: "inline",
          metadata: {
            originalName,
            sourceUrl,
            sourceRunId,
            firebaseStorageDownloadTokens: downloadToken,
          },
        },
      });

      // Construct Firebase Storage download URL (permanent, like client SDK's getDownloadURL)
      downloadUrl = getFirebaseStorageDownloadUrl(bucket.name, storagePath, downloadToken);

      const now = Timestamp.now();
      const fileDoc = {
        userId,
        fileName: originalName,
        fileType: mimeType,
        fileSize: buffer.length,
        storagePath,
        downloadUrl,
        contentHash,
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
        extractionComplete: false,
        transactionIds: [],
        sourceType: "browser" as const,
        sourceUrl,
        sourceDomain: extractDomain(sourceUrl),
        sourceRunId,
        sourceCollectorId: typeof sourceCollectorId === "string" ? sourceCollectorId : "basic",
        sourceResultType: "browser_invoice" as const,
      };

      ({ fileId, duplicate } = await createFileRecord(db, fileDoc));
    }

    // Auto-connect to transaction if transactionId was provided (learn mode)
    if (typeof transactionId === "string" && transactionId) {
      try {
        const txRef = db.collection("transactions").doc(transactionId);
        const txDoc = await txRef.get();
        if (txDoc.exists && txDoc.data()?.userId === userId) {
          const existingFileIds: string[] = txDoc.data()?.fileIds || [];
          if (!existingFileIds.includes(fileId)) {
            await txRef.update({
              fileIds: [...existingFileIds, fileId],
              updatedAt: Timestamp.now(),
            });
            // Also update the file with the transaction connection. The
            // File here can be one we already held (#182), and an existing
            // File can already be connected — so the new Transaction is added
            // to its transactionIds rather than replacing them, which would
            // strand every Transaction whose fileIds still point at it.
            const fileRef = db.collection(FILES_COLLECTION).doc(fileId);
            const connectedTo: string[] = (await fileRef.get()).data()?.transactionIds || [];
            if (!connectedTo.includes(transactionId)) {
              await fileRef.update({
                transactionIds: [...connectedTo, transactionId],
                updatedAt: Timestamp.now(),
              });
            }
          }
        }
      } catch (connectErr) {
        console.error("Auto-connect failed (non-fatal):", connectErr);
      }
    }

    return NextResponse.json({
      ok: true,
      fileId,
      downloadUrl,
      duplicate,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Browser upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
