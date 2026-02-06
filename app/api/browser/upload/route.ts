export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { createHash, randomUUID } from "crypto";
import { getAdminDb, getAdminBucket, getFirebaseStorageDownloadUrl } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

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
    const downloadUrl = getFirebaseStorageDownloadUrl(bucket.name, storagePath, downloadToken);
    const contentHash = createHash("sha256").update(buffer).digest("hex");

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

    const docRef = await db.collection(FILES_COLLECTION).add(fileDoc);

    // Auto-connect to transaction if transactionId was provided (learn mode)
    if (typeof transactionId === "string" && transactionId) {
      try {
        const txRef = db.collection("transactions").doc(transactionId);
        const txDoc = await txRef.get();
        if (txDoc.exists && txDoc.data()?.userId === userId) {
          const existingFileIds: string[] = txDoc.data()?.fileIds || [];
          if (!existingFileIds.includes(docRef.id)) {
            await txRef.update({
              fileIds: [...existingFileIds, docRef.id],
              updatedAt: Timestamp.now(),
            });
            // Also update the file with the transaction connection
            await docRef.update({
              transactionIds: [transactionId],
              updatedAt: Timestamp.now(),
            });
          }
        }
      } catch (connectErr) {
        console.error("Auto-connect failed (non-fatal):", connectErr);
      }
    }

    return NextResponse.json({
      ok: true,
      fileId: docRef.id,
      downloadUrl,
    });
  } catch (error) {
    console.error("Browser upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
