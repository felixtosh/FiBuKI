/**
 * Split a File that holds several separately issued invoices or Receipts into
 * one File per invoice or Receipt (#550).
 *
 * One PDF can carry several sellers' documents (Amazon Marketplace bundles
 * every seller's Rechnung or Quittung of an order into one download). As one
 * File it has one Partner, one invoice number, one Document Type and one
 * total, each wrong for part of the amount. A Split copies the pages of each
 * range, unedited, into a new File; every part is extracted, classified and
 * Partner-matched from scratch, connected to every Transaction the original
 * was on, and the original is deleted (reversible, never Purged: ADR-0006).
 *
 * Every rule lives here, for the callable and the `split_file` tool alike.
 * FiBuKI never splits on its own: Extraction only suggests the ranges.
 */

import { createHash, randomUUID } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { PDFDocument } from "pdf-lib";
import { createCallable, HttpsError } from "../utils/createCallable";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { sniffMimeTypeStrict } from "../extraction/geminiParser";
import { createFileRecord, findFileByContentHash } from "./createFileRecord";
import { generatedInvoiceRefusal } from "./generatedInvoiceGuard";
import { performDeleteFile } from "./deleteFile";
import { performConnectFileToTransaction } from "./connectFileToTransaction";

/** One part: a page range, 1-based and inclusive. */
export interface SplitRange {
  from: number;
  to: number;
}

export interface SplitPart {
  fileId: string;
  fileName: string;
  pages: [number, number];
}

export interface SplitFileResult {
  success: true;
  originalFileId: string;
  /** The new Files, in range order. */
  fileIds: string[];
  parts: SplitPart[];
  /** The Transactions every part was connected to. */
  transactionIds: string[];
}

/** A Split the rules refuse; nothing has been written when it is thrown. */
export class SplitRefusal extends Error {
  constructor(
    readonly code: "invalid-argument" | "failed-precondition" | "not-found",
    message: string
  ) {
    super(message);
    this.name = "SplitRefusal";
  }
}

/**
 * Check the requested ranges against the page count: at least two parts, each
 * at least one page, together every page exactly once, in order.
 */
export function validateSplitRanges(raw: unknown, pageCount: number): SplitRange[] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new SplitRefusal("invalid-argument", "A Split needs at least two page ranges.");
  }
  const ranges = raw.map((r, i) => {
    const from = (r as Partial<SplitRange> | null)?.from;
    const to = (r as Partial<SplitRange> | null)?.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new SplitRefusal(
        "invalid-argument",
        `Range ${i + 1} needs whole page numbers "from" and "to".`
      );
    }
    return { from: from as number, to: to as number };
  });

  let expected = 1;
  for (const [i, { from, to }] of ranges.entries()) {
    if (from > to) {
      throw new SplitRefusal("invalid-argument", `Range ${i + 1} (${from}-${to}) ends before it starts.`);
    }
    if (to > pageCount || from < 1) {
      throw new SplitRefusal(
        "invalid-argument",
        `Range ${i + 1} (${from}-${to}) is outside the document, which has ${pageCount} pages.`
      );
    }
    if (from < expected) {
      throw new SplitRefusal("invalid-argument", `Range ${i + 1} (${from}-${to}) overlaps the range before it.`);
    }
    if (from > expected) {
      throw new SplitRefusal(
        "invalid-argument",
        `${pagesAre(expected, from - 1)} in no range; every page must land in exactly one part.`
      );
    }
    expected = to + 1;
  }
  if (expected <= pageCount) {
    throw new SplitRefusal(
      "invalid-argument",
      `${pagesAre(expected, pageCount)} in no range; every page must land in exactly one part.`
    );
  }
  return ranges;
}

/** "Pages 3-4 are" / "Page 3 is", for a refusal. */
function pagesAre(from: number, to: number): string {
  return from === to ? `Page ${from} is` : `Pages ${from}-${to} are`;
}

/** "Order.pdf" with pages 3-4 → "Order (3-4).pdf". */
export function splitPartFileName(originalName: string, { from, to }: SplitRange): string {
  const base = originalName.replace(/\.pdf$/i, "") || "File";
  return `${base} (${from === to ? from : `${from}-${to}`}).pdf`;
}

/**
 * The bytes of each part: the original's pages, copied whole. No metadata is
 * stamped, so the same pages always give the same bytes and the same hash, and
 * a part already on file is recognised as one.
 */
export async function buildSplitParts(source: PDFDocument, ranges: SplitRange[]): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for (const { from, to } of ranges) {
    const part = await PDFDocument.create({ updateMetadata: false });
    const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    for (const page of await part.copyPages(source, indices)) part.addPage(page);
    parts.push(Buffer.from(await part.save()));
  }
  return parts;
}

/**
 * Load a File's bytes as a PDF a Split can work on, or refuse with the reason.
 */
async function loadSplittablePdf(bytes: Buffer): Promise<PDFDocument> {
  if (sniffMimeTypeStrict(bytes) !== "application/pdf") {
    throw new SplitRefusal("failed-precondition", "Only a PDF can be split; this File is not one.");
  }
  let pdf: PDFDocument;
  try {
    // Loaded past the encryption so it can be named: pdf-lib's own
    // EncryptedPDFError does not survive an instanceof check.
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new SplitRefusal("failed-precondition", "This PDF could not be read, so it cannot be split.");
  }
  if (pdf.isEncrypted) {
    throw new SplitRefusal(
      "failed-precondition",
      "This PDF is encrypted, so its pages cannot be copied. Remove the password and upload it again."
    );
  }
  return pdf;
}

/** Every Transaction the File is connected to. */
async function connectedTransactionIds(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<string[]> {
  const ids = new Set<string>();
  const connections = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("userId", "==", userId)
    .get();
  for (const c of connections.docs) {
    const txId = c.data().transactionId;
    if (typeof txId === "string") ids.add(txId);
  }
  for (const txId of (fileData.transactionIds ?? []) as unknown[]) {
    if (typeof txId === "string") ids.add(txId);
  }
  return [...ids];
}

export async function performSplitFile(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileId: string,
  rawRanges: unknown
): Promise<SplitFileResult> {
  if (!fileId) throw new SplitRefusal("invalid-argument", "fileId is required");

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();
  const fileData = fileSnap.data();
  if (!fileSnap.exists || !fileData || fileData.userId !== userId) {
    throw new SplitRefusal("not-found", "File not found");
  }
  if (fileData.deletedAt) {
    throw new SplitRefusal("failed-precondition", "A deleted File cannot be split. Restore it first.");
  }
  const generated = await generatedInvoiceRefusal(db, userId, fileData);
  if (generated) throw new SplitRefusal("failed-precondition", generated);
  if (typeof fileData.storagePath !== "string" || !fileData.storagePath) {
    throw new SplitRefusal("failed-precondition", "This File has no stored document to split.");
  }

  const bucket = getStorage().bucket();
  const [bytes] = await bucket.file(fileData.storagePath).download();
  const source = await loadSplittablePdf(bytes);
  const pageCount = source.getPageCount();
  if (pageCount < 2) {
    throw new SplitRefusal("failed-precondition", "This PDF has a single page, so there is nothing to split.");
  }
  const ranges = validateSplitRanges(rawRanges, pageCount);

  const partBytes = await buildSplitParts(source, ranges);
  const hashes = partBytes.map((b) => createHash("sha256").update(b).digest("hex"));
  if (new Set(hashes).size !== hashes.length) {
    throw new SplitRefusal("failed-precondition", "Two of the parts would hold identical pages.");
  }
  // A part already on file refuses the whole Split, before anything is written.
  for (const [i, hash] of hashes.entries()) {
    const existing = await findFileByContentHash(db, userId, hash);
    if (existing) {
      const name = existing.data().fileName ?? existing.id;
      throw new SplitRefusal(
        "failed-precondition",
        `${pagesAre(ranges[i].from, ranges[i].to)} already on file as "${name}"` +
          `${existing.data().deletedAt ? " (deleted; restore it instead)" : ""}. Nothing was split.`
      );
    }
  }

  // Write the parts. A part that turns out to be on file after all (a
  // concurrent write) undoes the ones written so far, so nothing half-applies.
  const fileName = typeof fileData.fileName === "string" ? fileData.fileName : "File.pdf";
  const written: Array<{ fileId: string; storagePath: string }> = [];
  const parts: SplitPart[] = [];
  const uploaded: string[] = [];
  try {
    for (const [i, range] of ranges.entries()) {
      const partName = splitPartFileName(fileName, range);
      const storagePath = `users/${userId}/files/${Date.now()}_${i + 1}_${partName}`;
      const downloadToken = randomUUID();
      await bucket.file(storagePath).save(partBytes[i], {
        contentType: "application/pdf",
        metadata: { metadata: { userId, firebaseStorageDownloadTokens: downloadToken } },
      });
      uploaded.push(storagePath);

      const now = FieldValue.serverTimestamp();
      const { fileId: partId, duplicate } = await createFileRecord(db, {
        userId,
        fileName: partName,
        fileType: "application/pdf",
        storagePath,
        downloadUrl: buildDownloadUrl(bucket.name, storagePath, downloadToken),
        contentHash: hashes[i],
        fileSize: partBytes[i].length,
        // Shown as where the original came from; the provider's message and
        // file ids stay on the original, so a Sync or Gone at Source never
        // acts on a part.
        ...(fileData.sourceType ? { sourceType: fileData.sourceType } : {}),
        splitFrom: { fileId, pages: [range.from, range.to] },
        pageCount: range.to - range.from + 1,
        transactionIds: [],
        isNotInvoice: false,
        extractionComplete: false,
        partnerMatchComplete: false,
        transactionMatchComplete: false,
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (duplicate) {
        throw new SplitRefusal(
          "failed-precondition",
          `${pagesAre(range.from, range.to)} already on file. Nothing was split.`
        );
      }
      written.push({ fileId: partId, storagePath });
      parts.push({ fileId: partId, fileName: partName, pages: [range.from, range.to] });
    }
  } catch (error) {
    // These records are seconds old and documented nothing yet.
    for (const w of written) await db.collection("files").doc(w.fileId).delete();
    for (const path of uploaded) await bucket.file(path).delete().catch(() => undefined);
    throw error;
  }

  // Connect every part where the original was, then delete the original, so
  // the bank line goes from the bundle to its parts with no gap a matcher
  // could step into. The delete detaches the original and recomputes each
  // Transaction; the matcher skips deleted Files, so no Rejection is needed.
  const transactionIds = await connectedTransactionIds(db, userId, fileId, fileData);
  for (const part of parts) {
    for (const transactionId of transactionIds) {
      await performConnectFileToTransaction(
        { db, userId },
        { fileId: part.fileId, transactionId, connectionType: "manual" }
      );
    }
  }

  await performDeleteFile(db, userId, fileId, fileData, { actor: "manual", summary: "Split into its parts" });
  await fileRef.update({
    splitInto: parts.map((p) => p.fileId),
    splitSuggestion: null,
    updatedAt: Timestamp.now(),
  });

  console.log(`[splitFile] Split ${fileId} into ${parts.length} Files`, { userId });

  return {
    success: true,
    originalFileId: fileId,
    fileIds: parts.map((p) => p.fileId),
    parts,
    transactionIds,
  };
}

/**
 * "Not a bundle": the suggestion goes, and re-extraction stores no new one
 * while the dismissal stands.
 */
export async function performDismissSplitSuggestion(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileId: string
): Promise<{ success: true }> {
  if (!fileId) throw new SplitRefusal("invalid-argument", "fileId is required");
  const ref = db.collection("files").doc(fileId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new SplitRefusal("not-found", "File not found");
  }
  await ref.update({
    splitSuggestion: null,
    splitSuggestionDismissed: true,
    updatedAt: Timestamp.now(),
  });
  return { success: true };
}

function asHttpsError(error: unknown): unknown {
  return error instanceof SplitRefusal ? new HttpsError(error.code, error.message) : error;
}

export const splitFileCallable = createCallable<
  { fileId: string; ranges: SplitRange[] },
  SplitFileResult
>({ name: "splitFile", timeoutSeconds: 120 }, async (ctx, request) => {
  try {
    return await performSplitFile(ctx.db, ctx.userId, request?.fileId, request?.ranges);
  } catch (error) {
    throw asHttpsError(error);
  }
});

export const dismissSplitSuggestionCallable = createCallable<{ fileId: string }, { success: true }>(
  { name: "dismissSplitSuggestion" },
  async (ctx, request) => {
    try {
      return await performDismissSplitSuggestion(ctx.db, ctx.userId, request?.fileId);
    } catch (error) {
      throw asHttpsError(error);
    }
  }
);
