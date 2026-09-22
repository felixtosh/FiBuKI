/**
 * Create a new file record (after uploading to storage).
 *
 * The duplicate check is not here: it is in `createFileRecord`, the write the
 * ingestion paths share (#182). This callable's job is to shape the record the
 * UI paths send.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { createFileRecord, MissingContentHashError } from "./createFileRecord";

interface CreateFileRequest {
  data: {
    fileName: string;
    fileType: string;
    fileSize: number;
    storagePath: string;
    downloadUrl: string;
    thumbnailUrl?: string;
    /** SHA-256 of the stored bytes. Required — see createFileRecord. */
    contentHash: string;
    // Source tracking
    sourceType?: string;
    sourceSearchPattern?: string;
    sourceResultType?: string;
    sourceUrl?: string;
    sourceDomain?: string;
    sourceRunId?: string;
    sourceCollectorId?: string;
    // Gmail source
    gmailMessageId?: string;
    gmailIntegrationId?: string;
    gmailIntegrationEmail?: string;
    gmailSubject?: string;
    gmailAttachmentId?: string;
    gmailSenderEmail?: string;
    gmailSenderDomain?: string;
    gmailSenderName?: string;
    gmailEmailDate?: string; // ISO date string
  };
}

interface CreateFileResponse {
  success: boolean;
  /** The new File, or the existing one carrying the same bytes. */
  fileId: string;
  /** True when the bytes were already on file and nothing was written. */
  duplicate: boolean;
}

export const createFileCallable = createCallable<
  CreateFileRequest,
  CreateFileResponse
>(
  { name: "createFile" },
  async (ctx, request) => {
    const { data } = request;

    if (!data?.fileName) {
      throw new HttpsError("invalid-argument", "fileName is required");
    }
    if (!data?.storagePath) {
      throw new HttpsError("invalid-argument", "storagePath is required");
    }
    if (!data?.downloadUrl) {
      throw new HttpsError("invalid-argument", "downloadUrl is required");
    }

    const now = Timestamp.now();

    // Build file object, excluding undefined values
    const newFile: Record<string, unknown> = {
      userId: ctx.userId,
      fileName: data.fileName,
      fileType: data.fileType || "application/octet-stream",
      fileSize: data.fileSize || 0,
      storagePath: data.storagePath,
      downloadUrl: data.downloadUrl,
      extractionComplete: false,
      transactionIds: [],
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // Add optional fields only if they have values
    if (data.thumbnailUrl) newFile.thumbnailUrl = data.thumbnailUrl;
    if (data.contentHash) newFile.contentHash = data.contentHash;
    if (data.sourceType) newFile.sourceType = data.sourceType;
    if (data.sourceSearchPattern) newFile.sourceSearchPattern = data.sourceSearchPattern;
    if (data.sourceResultType) newFile.sourceResultType = data.sourceResultType;
    if (data.sourceUrl) newFile.sourceUrl = data.sourceUrl;
    if (data.sourceDomain) newFile.sourceDomain = data.sourceDomain;
    if (data.sourceRunId) newFile.sourceRunId = data.sourceRunId;
    if (data.sourceCollectorId) newFile.sourceCollectorId = data.sourceCollectorId;
    if (data.gmailMessageId) newFile.gmailMessageId = data.gmailMessageId;
    if (data.gmailIntegrationId) newFile.gmailIntegrationId = data.gmailIntegrationId;
    if (data.gmailIntegrationEmail) newFile.gmailIntegrationEmail = data.gmailIntegrationEmail;
    if (data.gmailSubject) newFile.gmailSubject = data.gmailSubject;
    if (data.gmailAttachmentId) newFile.gmailAttachmentId = data.gmailAttachmentId;
    if (data.gmailSenderEmail) newFile.gmailSenderEmail = data.gmailSenderEmail;
    if (data.gmailSenderDomain) newFile.gmailSenderDomain = data.gmailSenderDomain;
    if (data.gmailSenderName) newFile.gmailSenderName = data.gmailSenderName;
    if (data.gmailEmailDate) {
      const dateObj = new Date(data.gmailEmailDate);
      if (!isNaN(dateObj.getTime())) {
        newFile.gmailEmailDate = Timestamp.fromDate(dateObj);
      }
    }

    let result;
    try {
      result = await createFileRecord(ctx.db, newFile);
    } catch (err) {
      if (err instanceof MissingContentHashError) {
        throw new HttpsError("invalid-argument", err.message);
      }
      throw err;
    }

    if (result.duplicate) {
      console.log(`[createFile] Bytes already on file ${result.fileId}`, {
        userId: ctx.userId,
        fileName: data.fileName,
      });
    } else {
      console.log(`[createFile] Created file ${result.fileId}`, {
        userId: ctx.userId,
        fileName: data.fileName,
      });
    }

    return {
      success: true,
      fileId: result.fileId,
      duplicate: result.duplicate,
    };
  }
);
