import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  Timestamp,
  writeBatch,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import {
  TaxFile,
  FileConnection,
  FileFilters,
  FileCreateData,
  FileExtractionData,
  ExtractedLineItem,
  TransactionSuggestion,
} from "@/types/file";
import { Transaction } from "@/types/transaction";
import { FileSourceResultType, FileSourceType, ManualFileRemoval } from "@/types/partner";
import {
  createLocalPartnerFromGlobal,
  decrementFileSourcePatternUsage,
  learnFileSourcePattern,
} from "./partner-ops";
import { OperationsContext } from "./types";

const PARTNERS_COLLECTION = "partners";

/**
 * Source info for tracking how a file was found when connecting
 */
export interface FileConnectionSourceInfo {
  /** Where the file was found */
  sourceType: FileSourceType;
  /** The search pattern/query used */
  searchPattern?: string;
  /** For Gmail: which integration (account) */
  gmailIntegrationId?: string;
  /** For Gmail: integration email */
  gmailIntegrationEmail?: string;
  /** For Gmail: message ID */
  gmailMessageId?: string;
  /** For Gmail: sender email */
  gmailMessageFrom?: string;
  /** For Gmail: sender name */
  gmailMessageFromName?: string;
  /** Type of result selected during the connection */
  resultType?: FileSourceResultType;
}

const FILES_COLLECTION = "files";
const FILE_CONNECTIONS_COLLECTION = "fileConnections";
const TRANSACTIONS_COLLECTION = "transactions";

// === Partner Resolution ===

export type PartnerMatchedBy = "manual" | "suggestion" | "auto" | null;

/**
 * Resolve partner conflict between file and transaction.
 * Implements bidirectional sync with manual-wins priority.
 *
 * Rules:
 * - Neither has partner → no sync
 * - Only one has partner → sync to the other
 * - Manual wins over auto/suggestion
 * - Both manual → no sync (keep both as-is, they both chose intentionally)
 * - Both auto → higher confidence wins, tie goes to transaction (bank statement)
 */
export function resolvePartnerConflict(
  filePartnerId: string | null | undefined,
  fileMatchedBy: PartnerMatchedBy,
  fileConfidence: number | null | undefined,
  txPartnerId: string | null | undefined,
  txMatchedBy: PartnerMatchedBy,
  txConfidence: number | null | undefined
): { winnerId: string | null; source: "file" | "transaction" | null; shouldSync: boolean } {
  const filePid = filePartnerId ?? null;
  const txPid = txPartnerId ?? null;

  // Neither has partner
  if (!filePid && !txPid) {
    return { winnerId: null, source: null, shouldSync: false };
  }

  // Only file has partner → sync to transaction
  if (filePid && !txPid) {
    return { winnerId: filePid, source: "file", shouldSync: true };
  }

  // Only transaction has partner → sync to file
  if (txPid && !filePid) {
    return { winnerId: txPid, source: "transaction", shouldSync: true };
  }

  // Both have partners - determine winner
  const fileIsManual = fileMatchedBy === "manual";
  const txIsManual = txMatchedBy === "manual";

  // Both manual → no sync (both were intentional choices)
  if (fileIsManual && txIsManual) {
    return { winnerId: null, source: null, shouldSync: false };
  }

  // File is manual, transaction is not → file wins, sync to transaction
  if (fileIsManual && !txIsManual) {
    return { winnerId: filePid!, source: "file", shouldSync: true };
  }

  // Transaction is manual, file is not → transaction wins, sync to file
  if (txIsManual && !fileIsManual) {
    return { winnerId: txPid!, source: "transaction", shouldSync: true };
  }

  // Both auto/suggestion → higher confidence wins
  const fileConf = fileConfidence ?? 0;
  const txConf = txConfidence ?? 0;

  if (fileConf > txConf) {
    return { winnerId: filePid!, source: "file", shouldSync: true };
  } else if (txConf > fileConf) {
    return { winnerId: txPid!, source: "transaction", shouldSync: true };
  }

  // Equal confidence → transaction wins (bank statement is primary source)
  return { winnerId: txPid!, source: "transaction", shouldSync: true };
}

function getEffectiveExtractedAmount(file: TaxFile): number | null {
  const lineItems = file.extractedLineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return file.extractedAmount ?? null;
  }

  const amountFromItems = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const vatFromItems = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const amountsLookNet = vatFromItems > 0 && inferLineItemAmountsAreNet(lineItems);

  if (amountsLookNet) {
    return amountFromItems + vatFromItems;
  }

  return file.extractedAmount ?? amountFromItems;
}

function normalizeFileMonetaryFields(file: TaxFile): TaxFile {
  const lineItems = file.extractedLineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return file;
  }

  const vatFromItems = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const effectiveAmount = getEffectiveExtractedAmount(file);

  return {
    ...file,
    extractedAmount: effectiveAmount,
    extractedVatAmount: file.extractedVatAmount ?? vatFromItems,
  };
}

/**
 * List all files for the current user with optional filters
 */
export async function listFiles(
  ctx: OperationsContext,
  filters?: FileFilters & { limit?: number }
): Promise<TaxFile[]> {
  const constraints: Parameters<typeof query>[1][] = [
    where("userId", "==", ctx.userId),
    orderBy("uploadedAt", "desc"),
  ];

  if (filters?.extractionComplete !== undefined) {
    constraints.push(where("extractionComplete", "==", filters.extractionComplete));
  }

  const q = query(collection(ctx.db, FILES_COLLECTION), ...constraints);
  const snapshot = await getDocs(q);

  let files = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }) as TaxFile).map((file) => normalizeFileMonetaryFields(file));

  // Filter out soft-deleted files by default (unless includeDeleted is true)
  if (!filters?.includeDeleted) {
    files = files.filter((f) => !f.deletedAt);
  }

  // Client-side filters
  if (filters?.search) {
    const searchLower = filters.search.toLowerCase();
    files = files.filter(
      (f) =>
        f.fileName.toLowerCase().includes(searchLower) ||
        (f.extractedPartner?.toLowerCase() || "").includes(searchLower)
    );
  }

  if (filters?.hasConnections !== undefined) {
    files = files.filter((f) =>
      filters.hasConnections
        ? f.transactionIds.length > 0
        : f.transactionIds.length === 0
    );
  }

  // Filter by isNotInvoice status
  if (filters?.isNotInvoice !== undefined) {
    files = files.filter((f) =>
      filters.isNotInvoice ? f.isNotInvoice === true : f.isNotInvoice !== true
    );
  }

  if (filters?.uploadedFrom) {
    const fromTimestamp = Timestamp.fromDate(filters.uploadedFrom);
    files = files.filter((f) => f.uploadedAt.toMillis() >= fromTimestamp.toMillis());
  }

  if (filters?.uploadedTo) {
    const toTimestamp = Timestamp.fromDate(filters.uploadedTo);
    files = files.filter((f) => f.uploadedAt.toMillis() <= toTimestamp.toMillis());
  }

  if (filters?.extractedDateFrom) {
    const fromTimestamp = Timestamp.fromDate(filters.extractedDateFrom);
    files = files.filter(
      (f) => f.extractedDate && f.extractedDate.toMillis() >= fromTimestamp.toMillis()
    );
  }

  if (filters?.extractedDateTo) {
    const toTimestamp = Timestamp.fromDate(filters.extractedDateTo);
    files = files.filter(
      (f) => f.extractedDate && f.extractedDate.toMillis() <= toTimestamp.toMillis()
    );
  }

  if (filters?.limit) {
    files = files.slice(0, filters.limit);
  }

  return files;
}

/**
 * Get a single file by ID
 */
export async function getFile(
  ctx: OperationsContext,
  fileId: string
): Promise<TaxFile | null> {
  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  if (data.userId !== ctx.userId) {
    return null;
  }

  return normalizeFileMonetaryFields({ id: snapshot.id, ...data } as TaxFile);
}

/**
 * Check if a file with the same content hash already exists
 */
export async function checkFileDuplicate(
  ctx: OperationsContext,
  contentHash: string
): Promise<TaxFile | null> {
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("contentHash", "==", contentHash)
  );
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return normalizeFileMonetaryFields({ id: doc.id, ...doc.data() } as TaxFile);
}

/**
 * Create a new file record (after uploading to storage)
 */
export async function createFile(
  ctx: OperationsContext,
  data: FileCreateData
): Promise<string> {
  const now = Timestamp.now();

  // Build file object, excluding undefined values (Firestore doesn't accept them)
  const newFile: Record<string, unknown> = {
    userId: ctx.userId,
    fileName: data.fileName,
    fileType: data.fileType,
    fileSize: data.fileSize,
    storagePath: data.storagePath,
    downloadUrl: data.downloadUrl,
    extractionComplete: false,
    transactionIds: [],
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Only add optional fields if they have values
  if (data.thumbnailUrl) {
    newFile.thumbnailUrl = data.thumbnailUrl;
  }
  if (data.contentHash) {
    newFile.contentHash = data.contentHash;
  }

  // Source tracking
  if (data.sourceType) {
    newFile.sourceType = data.sourceType;
  }
  if (data.sourceSearchPattern) {
    newFile.sourceSearchPattern = data.sourceSearchPattern;
  }
  if (data.sourceResultType) {
    newFile.sourceResultType = data.sourceResultType;
  }
  if (data.sourceUrl) {
    newFile.sourceUrl = data.sourceUrl;
  }
  if (data.sourceDomain) {
    newFile.sourceDomain = data.sourceDomain;
  }
  if (data.sourceRunId) {
    newFile.sourceRunId = data.sourceRunId;
  }
  if (data.sourceCollectorId) {
    newFile.sourceCollectorId = data.sourceCollectorId;
  }
  if (data.gmailMessageId) {
    newFile.gmailMessageId = data.gmailMessageId;
  }
  if (data.gmailIntegrationId) {
    newFile.gmailIntegrationId = data.gmailIntegrationId;
  }
  if (data.gmailIntegrationEmail) {
    newFile.gmailIntegrationEmail = data.gmailIntegrationEmail;
  }
  if (data.gmailSubject) {
    newFile.gmailSubject = data.gmailSubject;
  }
  if (data.gmailAttachmentId) {
    newFile.gmailAttachmentId = data.gmailAttachmentId;
  }
  if (data.gmailSenderEmail) {
    newFile.gmailSenderEmail = data.gmailSenderEmail;
  }
  if (data.gmailSenderDomain) {
    newFile.gmailSenderDomain = data.gmailSenderDomain;
  }
  if (data.gmailSenderName) {
    newFile.gmailSenderName = data.gmailSenderName;
  }
  if (data.gmailEmailDate) {
    newFile.gmailEmailDate = data.gmailEmailDate;
  }

  const docRef = await addDoc(collection(ctx.db, FILES_COLLECTION), newFile);
  return docRef.id;
}

/**
 * Update a file's extraction results
 */
export async function updateFileExtraction(
  ctx: OperationsContext,
  fileId: string,
  data: FileExtractionData
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    ...data,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Update a file's metadata (not extraction data)
 */
export async function updateFile(
  ctx: OperationsContext,
  fileId: string,
  data: Partial<Pick<TaxFile, "fileName" | "thumbnailUrl">>
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    ...data,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Update the invoice direction for a file
 */
export async function updateFileDirection(
  ctx: OperationsContext,
  fileId: string,
  direction: "incoming" | "outgoing" | "unknown"
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    invoiceDirection: direction,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Editable additional field (label + value pair)
 */
export interface EditableAdditionalField {
  label: string;
  value: string;
}

export interface EditableLineItem {
  description: string;
  quantity: string;
  /** Currency units (not cents) */
  unitPrice: string;
  vatPercent: string;
  /** Currency units (not cents) */
  vatAmount: string;
  /** Currency units (not cents) */
  amount: string;
}

/**
 * User-editable extracted fields (string-based for form inputs)
 */
export interface EditableExtractedFields {
  date: string; // yyyy-MM-dd format
  amount: string; // number as string (in currency units, not cents)
  vatPercent: string; // number as string
  partner: string;
  vatId: string;
  iban: string;
  address: string;
  additionalFields: EditableAdditionalField[]; // dynamic key-value pairs
  lineItems?: EditableLineItem[]; // editable invoice line items
}

function parseNumberInput(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCurrencyToCents(value: string): number | null {
  const parsed = parseNumberInput(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function normalizeEditableLineItems(lineItems: EditableLineItem[] | undefined): ExtractedLineItem[] {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems
    .map((item, index): ExtractedLineItem | null => {
      const amount = parseCurrencyToCents(item.amount);
      if (amount === null) {
        return null;
      }

      const quantity = parseNumberInput(item.quantity);
      let unitPrice = parseCurrencyToCents(item.unitPrice);

      const rawVatPercent = parseNumberInput(item.vatPercent);
      const vatPercent = rawVatPercent !== null && rawVatPercent >= 0 && rawVatPercent <= 100
        ? rawVatPercent
        : null;

      let vatAmount = parseCurrencyToCents(item.vatAmount);
      if (vatAmount === null && vatPercent !== null) {
        vatAmount = Math.round((amount * vatPercent) / (100 + vatPercent));
      }
      if (vatAmount === null) {
        vatAmount = 0;
      }

      if (unitPrice === null && quantity && quantity !== 0) {
        const amountLooksNet = vatPercent !== null && vatPercent > 0
          ? Math.abs(Math.round((amount * vatPercent) / 100) - vatAmount) <
            Math.abs(Math.round((amount * vatPercent) / (100 + vatPercent)) - vatAmount)
          : false;
        const netAmount = amountLooksNet ? amount : amount - vatAmount;
        unitPrice = Math.round(netAmount / quantity);
      }

      return {
        description: item.description.trim() || `Item ${index + 1}`,
        quantity,
        unitPrice,
        vatPercent,
        vatAmount,
        amount,
      };
    })
    .filter((item): item is ExtractedLineItem => item !== null);
}

function inferLineItemAmountsAreNet(lineItems: ExtractedLineItem[]): boolean {
  let comparedItems = 0;
  let netInterpretationError = 0;
  let grossInterpretationError = 0;

  for (const item of lineItems) {
    if (
      item.vatPercent === null ||
      !Number.isFinite(item.vatPercent) ||
      item.vatPercent <= 0 ||
      !Number.isFinite(item.vatAmount)
    ) {
      continue;
    }

    const rate = item.vatPercent;
    const expectedVatIfNet = Math.round((item.amount * rate) / 100);
    const expectedVatIfGross = Math.round((item.amount * rate) / (100 + rate));

    netInterpretationError += Math.abs(expectedVatIfNet - item.vatAmount);
    grossInterpretationError += Math.abs(expectedVatIfGross - item.vatAmount);
    comparedItems += 1;
  }

  if (comparedItems === 0) {
    return false;
  }

  return netInterpretationError < grossInterpretationError;
}

function consolidateLineItems(
  lineItems: ExtractedLineItem[],
  explicitDocumentAmount?: number | null
): {
  amount: number;
  vatAmount: number;
  vatPercent: number | null;
} {
  const amountFromItems = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const vatAmount = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const amountFromNetPlusVat = amountFromItems + vatAmount;

  const firstRate = lineItems[0]?.vatPercent ?? null;
  const hasSingleRate = firstRate !== null && lineItems.every((item) =>
    item.vatPercent !== null && Math.abs(item.vatPercent - firstRate) < 0.0001
  );

  let amount = amountFromItems;
  if (typeof explicitDocumentAmount === "number" && Number.isFinite(explicitDocumentAmount)) {
    const distanceToAsIs = Math.abs(amountFromItems - explicitDocumentAmount);
    const distanceToNetPlusVat = Math.abs(amountFromNetPlusVat - explicitDocumentAmount);
    amount = distanceToNetPlusVat < distanceToAsIs ? amountFromNetPlusVat : amountFromItems;
  } else {
    const amountsLookNet = vatAmount > 0 && inferLineItemAmountsAreNet(lineItems);
    amount = amountsLookNet ? amountFromNetPlusVat : amountFromItems;
  }

  return {
    amount,
    vatAmount,
    vatPercent: hasSingleRate ? firstRate : null,
  };
}

/**
 * Update a file's extracted fields from user edits.
 * Handles conversion from string inputs to proper types.
 */
export async function updateFileExtractedFields(
  ctx: OperationsContext,
  fileId: string,
  fields: EditableExtractedFields
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // Convert string inputs to proper types
  const updates: Record<string, unknown> = {
    updatedAt: Timestamp.now(),
  };

  // Date: convert from yyyy-MM-dd string to Timestamp
  if (fields.date) {
    const dateObj = new Date(fields.date);
    if (!isNaN(dateObj.getTime())) {
      updates.extractedDate = Timestamp.fromDate(dateObj);
    }
  } else {
    updates.extractedDate = null;
  }

  const normalizedLineItems = normalizeEditableLineItems(fields.lineItems);
  const hasLineItems = fields.lineItems !== undefined && normalizedLineItems.length > 0;

  if (hasLineItems) {
    const explicitAmount = parseCurrencyToCents(fields.amount);
    const consolidated = consolidateLineItems(normalizedLineItems, explicitAmount);
    updates.extractedLineItems = normalizedLineItems;
    updates.extractedAmount = consolidated.amount;
    updates.extractedVatAmount = consolidated.vatAmount;
    updates.extractedVatPercent = consolidated.vatPercent;
  } else {
    if (fields.lineItems !== undefined) {
      updates.extractedLineItems = null;
      updates.extractedVatAmount = null;
    }

    // Amount: convert from currency units to cents
    if (fields.amount) {
      const amountNum = parseNumberInput(fields.amount);
      if (amountNum !== null) {
        updates.extractedAmount = Math.round(amountNum * 100);
      }
    } else {
      updates.extractedAmount = null;
    }

    // VAT percent: convert to number
    if (fields.vatPercent) {
      const vatNum = parseNumberInput(fields.vatPercent);
      if (vatNum !== null) {
        updates.extractedVatPercent = vatNum;
      }
    } else {
      updates.extractedVatPercent = null;
    }
  }

  // String fields: use value or null if empty
  updates.extractedPartner = fields.partner || null;
  updates.extractedVatId = fields.vatId || null;
  updates.extractedIban = fields.iban || null;
  updates.extractedAddress = fields.address || null;

  // Additional fields: filter out empty ones, map to storage format
  const additionalFields = fields.additionalFields
    .filter((f) => f.label.trim() && f.value.trim())
    .map((f) => ({
      label: f.label.trim(),
      value: f.value.trim(),
      rawValue: f.value.trim(), // use edited value as raw
    }));
  updates.extractedAdditionalFields = additionalFields.length > 0 ? additionalFields : null;

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, updates);
}

/**
 * Retry extraction for a file that had an error
 * Calls the Cloud Function to re-run extraction
 * @param force - If true, bypasses checks and forces re-extraction (used to upgrade old files)
 */
export async function retryFileExtraction(
  ctx: OperationsContext,
  fileId: string,
  force?: boolean
): Promise<void> {
  const { getFunctions, httpsCallable } = await import("firebase/functions");
  const functions = getFunctions(undefined, "europe-west1");
  const retryFn = httpsCallable(functions, "retryFileExtraction");
  await retryFn({ fileId, force });
}

/**
 * Re-extract all files connected to a partner.
 * Used when a partner is marked as "this is my company" to recalculate counterparties.
 * Returns the number of files queued for re-extraction.
 *
 * Files are processed in parallel batches for better performance.
 */
export async function reextractFilesForPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<{ queuedCount: number; fileIds: string[] }> {
  // Find all files with this partner
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("partnerId", "==", partnerId)
  );

  const snapshot = await getDocs(q);
  const allFileIds = snapshot.docs.map((doc) => doc.id);

  if (allFileIds.length === 0) {
    return { queuedCount: 0, fileIds: [] };
  }

  // Queue re-extraction in parallel batches for better performance
  const { getFunctions, httpsCallable } = await import("firebase/functions");
  const functions = getFunctions(undefined, "europe-west1");
  const retryFn = httpsCallable(functions, "retryFileExtraction");

  const BATCH_SIZE = 5; // Process 5 files in parallel at a time
  const successfulIds: string[] = [];

  for (let i = 0; i < allFileIds.length; i += BATCH_SIZE) {
    const batch = allFileIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((fileId) => retryFn({ fileId, force: true }).then(() => fileId))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        successfulIds.push(result.value);
      } else {
        console.error(`Failed to queue re-extraction:`, result.reason);
      }
    }
  }

  return { queuedCount: successfulIds.length, fileIds: successfulIds };
}

/**
 * Soft delete a file (Gmail files) - marks as deleted but keeps for deduplication
 * This prevents the file from being re-imported from Gmail
 */
export async function softDeleteFile(
  ctx: OperationsContext,
  fileId: string
): Promise<{ deletedConnections: number }> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // 1. Delete all connections and update transactions
  const connectionsResult = await deleteFileConnections(ctx, fileId);

  // 2. Soft delete the file document (keep for deduplication)
  // Clear transactionIds to prevent showing in transaction file lists
  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    deletedAt: Timestamp.now(),
    transactionIds: [],
    updatedAt: Timestamp.now(),
  });

  return { deletedConnections: connectionsResult.deleted };
}

/**
 * Restore a soft-deleted file
 */
export async function restoreFile(
  ctx: OperationsContext,
  fileId: string
): Promise<void> {
  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    throw new Error(`File ${fileId} not found`);
  }

  const data = snapshot.data();
  if (data.userId !== ctx.userId) {
    throw new Error(`File ${fileId} access denied`);
  }

  await updateDoc(docRef, {
    deletedAt: null,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Hard delete a file and all its connections (permanent deletion)
 */
export async function deleteFile(
  ctx: OperationsContext,
  fileId: string
): Promise<{ deletedConnections: number }> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // 1. Delete all connections and update transactions
  const connectionsResult = await deleteFileConnections(ctx, fileId);

  // 2. Delete the file document
  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await deleteDoc(docRef);

  return { deletedConnections: connectionsResult.deleted };
}

/**
 * Mark a file as "not an invoice" (user override)
 * Clears extracted data and resets downstream matching.
 * Preserves manually-set partner assignments.
 */
export async function markFileAsNotInvoice(
  ctx: OperationsContext,
  fileId: string,
  reason?: string
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // Build update object
  const updates: Record<string, unknown> = {
    isNotInvoice: true,
    notInvoiceReason: reason || "Marked by user",
    classificationComplete: true, // Classification is done (user decided)
    // Clear all extracted data since it's not an invoice
    extractedDate: null,
    extractedAmount: null,
    extractedCurrency: null,
    extractedVatPercent: null,
    extractedVatAmount: null,
    extractedLineItems: null,
    extractedPartner: null,
    extractedVatId: null,
    extractedIban: null,
    extractedAddress: null,
    extractedText: null,
    extractedRaw: null,
    extractedAdditionalFields: null,
    extractedFields: null,
    extractionConfidence: null,
    invoiceDirection: null,
    // Mark extraction as complete (nothing to extract for non-invoices)
    extractionComplete: true,
    // Reset downstream matching
    partnerMatchComplete: false,
    partnerSuggestions: [],
    transactionMatchComplete: false,
    transactionSuggestions: [],
    updatedAt: Timestamp.now(),
  };

  // Only clear partner if NOT manually set (preserve user's intentional choice)
  if (existing.partnerMatchedBy !== "manual") {
    updates.partnerId = null;
    updates.partnerType = null;
    updates.partnerMatchedBy = null;
    updates.partnerMatchConfidence = null;
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, updates);
}

/**
 * Unmark a file as "not an invoice" (restore as invoice)
 * Triggers re-extraction while preserving manually-set partner and transactions.
 */
export async function unmarkFileAsNotInvoice(
  ctx: OperationsContext,
  fileId: string
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // Build update object
  const updates: Record<string, unknown> = {
    isNotInvoice: false,
    notInvoiceReason: null,
    // Skip classification - user has confirmed it's an invoice
    classificationComplete: true,
    // Reset extraction to trigger re-extraction
    extractionComplete: false,
    extractionError: null,
    updatedAt: Timestamp.now(),
  };

  // Only reset partner if NOT manually set (preserve user's intentional choice)
  if (existing.partnerMatchedBy !== "manual") {
    updates.partnerId = null;
    updates.partnerType = null;
    updates.partnerMatchedBy = null;
    updates.partnerMatchConfidence = null;
    updates.partnerMatchComplete = false;
    updates.partnerSuggestions = [];
  }

  // Check for manual transaction connections before resetting transaction matching
  const connectionsQ = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("fileId", "==", fileId),
    where("connectionType", "==", "manual")
  );
  const manualConnections = await getDocs(connectionsQ);

  // Only reset transaction matching if no manual connections exist
  if (manualConnections.empty) {
    updates.transactionMatchComplete = false;
    updates.transactionSuggestions = [];
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, updates);
}

// === File-Transaction Connection Operations ===

/**
 * Connect a file to a transaction (many-to-many)
 */
export async function connectFileToTransaction(
  ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  connectionType: "manual" | "auto_matched" = "manual",
  matchConfidence?: number,
  sourceInfo?: FileConnectionSourceInfo
): Promise<string> {
  // Verify file ownership
  const file = await getFile(ctx, fileId);
  if (!file) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  // Verify transaction ownership
  const transactionDoc = await getDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
  if (!transactionDoc.exists() || transactionDoc.data().userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  // Check if connection already exists
  const existingQ = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("fileId", "==", fileId),
    where("transactionId", "==", transactionId),
    where("userId", "==", ctx.userId)
  );
  const existingSnap = await getDocs(existingQ);
  if (!existingSnap.empty) {
    return existingSnap.docs[0].id; // Already connected
  }

  const now = Timestamp.now();
  const batch = writeBatch(ctx.db);

  // 1. Create junction document
  const connectionRef = doc(collection(ctx.db, FILE_CONNECTIONS_COLLECTION));
  // Build connection data, only including defined fields (Firestore doesn't allow undefined)
  const connectionData: Record<string, unknown> = {
    fileId,
    transactionId,
    userId: ctx.userId,
    connectionType,
    matchConfidence: matchConfidence ?? null,
    createdAt: now,
  };

  // Add source tracking fields only if provided
  if (sourceInfo?.sourceType) {
    connectionData.sourceType = sourceInfo.sourceType;
  }
  if (sourceInfo?.searchPattern) {
    connectionData.searchPattern = sourceInfo.searchPattern;
  }
  if (sourceInfo?.gmailIntegrationId) {
    connectionData.gmailIntegrationId = sourceInfo.gmailIntegrationId;
  }
  if (sourceInfo?.gmailIntegrationEmail) {
    connectionData.gmailIntegrationEmail = sourceInfo.gmailIntegrationEmail;
  }
  if (sourceInfo?.gmailMessageId) {
    connectionData.gmailMessageId = sourceInfo.gmailMessageId;
  }
  if (sourceInfo?.gmailMessageFrom) {
    connectionData.gmailMessageFrom = sourceInfo.gmailMessageFrom;
  }
  if (sourceInfo?.gmailMessageFromName) {
    connectionData.gmailMessageFromName = sourceInfo.gmailMessageFromName;
  }
  if (sourceInfo?.resultType) {
    connectionData.resultType = sourceInfo.resultType;
  }

  batch.set(connectionRef, connectionData);

  // 2. Update file's transactionIds array
  const fileRef = doc(ctx.db, FILES_COLLECTION, fileId);
  const fileUpdates: Record<string, unknown> = {
    transactionIds: arrayUnion(transactionId),
    updatedAt: now,
  };

  // 3. Update transaction's fileIds array and mark as complete
  const transactionRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const txData = transactionDoc.data();
  const transactionUpdates: Record<string, unknown> = {
    fileIds: arrayUnion(fileId),
    isComplete: true,
    updatedAt: now,
  };

  const localizePartner = async (
    partnerId: string | null | undefined,
    partnerType: "user" | "global" | null | undefined
  ): Promise<{ partnerId: string | null; partnerType: "user" | "global" | null; localized: boolean }> => {
    if (!partnerId || partnerType !== "global") {
      return { partnerId: partnerId ?? null, partnerType: partnerType ?? null, localized: false };
    }

    try {
      const { localPartnerId } = await createLocalPartnerFromGlobal(ctx, partnerId);
      return { partnerId: localPartnerId, partnerType: "user", localized: true };
    } catch (error) {
      console.error(`[PartnerMatch] Failed to localize global partner ${partnerId}:`, error);
      return { partnerId, partnerType, localized: false };
    }
  };

  const resolvedTxPartner = await localizePartner(txData.partnerId, txData.partnerType);
  if (resolvedTxPartner.localized) {
    transactionUpdates.partnerId = resolvedTxPartner.partnerId;
    transactionUpdates.partnerType = "user";
  }

  const resolvedFilePartner = await localizePartner(file.partnerId, file.partnerType ?? null);
  if (resolvedFilePartner.localized) {
    fileUpdates.partnerId = resolvedFilePartner.partnerId;
    fileUpdates.partnerType = "user";
  }

  if (sourceInfo?.searchPattern) {
    const patternPartnerId = resolvedTxPartner.partnerId ?? resolvedFilePartner.partnerId ?? null;
    if (patternPartnerId) {
      try {
        await learnFileSourcePattern(ctx, patternPartnerId, transactionId, {
          sourceType: sourceInfo.sourceType,
          searchPattern: sourceInfo.searchPattern,
          integrationId: sourceInfo.gmailIntegrationId,
          resultType: sourceInfo.resultType,
        });
      } catch (error) {
        console.error("Failed to learn file source pattern:", error);
      }
    }
  }

  // 4. Partner sync: Resolve conflict and sync partner bidirectionally
  // Defer partner sync until extraction completes so file partner is authoritative.
  if (file.extractionComplete === true) {
    const resolution = resolvePartnerConflict(
      resolvedFilePartner.partnerId,
      file.partnerMatchedBy as PartnerMatchedBy,
      file.partnerMatchConfidence,
      resolvedTxPartner.partnerId,
      txData.partnerMatchedBy as PartnerMatchedBy,
      txData.partnerMatchConfidence
    );

    if (resolution.shouldSync && resolution.winnerId) {
      if (resolution.source === "file") {
        // File wins → sync file's partner to transaction
        transactionUpdates.partnerId = resolvedFilePartner.partnerId;
        transactionUpdates.partnerType = resolvedFilePartner.partnerType;
        // Keep "auto" if syncing, unless file was manual
        transactionUpdates.partnerMatchedBy = file.partnerMatchedBy === "manual" ? "manual" : "auto";
        transactionUpdates.partnerMatchConfidence = file.partnerMatchConfidence ?? null;
        console.log(
          `[FileConnect] Synced partner ${resolvedFilePartner.partnerId} from file to transaction ${transactionId} ` +
          `(file: ${file.partnerMatchConfidence ?? 0}% vs tx: ${txData.partnerMatchConfidence ?? 0}%)`
        );
      } else if (resolution.source === "transaction") {
        // Transaction wins → sync transaction's partner to file
        fileUpdates.partnerId = resolvedTxPartner.partnerId;
        fileUpdates.partnerType = resolvedTxPartner.partnerType;
        // Keep "auto" if syncing, unless transaction was manual
        fileUpdates.partnerMatchedBy = txData.partnerMatchedBy === "manual" ? "manual" : "auto";
        fileUpdates.partnerMatchConfidence = txData.partnerMatchConfidence ?? null;
        console.log(
          `[FileConnect] Synced partner ${resolvedTxPartner.partnerId} from transaction to file ${fileId} ` +
          `(tx: ${txData.partnerMatchConfidence ?? 0}% vs file: ${file.partnerMatchConfidence ?? 0}%)`
        );
      }
    }
  } else {
    console.log(
      `[FileConnect] Deferred partner sync for file ${fileId} until extraction completes`
    );
  }

  batch.update(fileRef, fileUpdates);
  batch.update(transactionRef, transactionUpdates);

  await batch.commit();
  return connectionRef.id;
}

/**
 * Disconnect a file from a transaction
 * @param rejectFile If true, adds the file to transaction's rejectedFileIds to prevent auto-reconnection
 */
export async function disconnectFileFromTransaction(
  ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  rejectFile: boolean = false
): Promise<void> {
  // Verify file exists and belongs to user
  const fileDoc = await getDoc(doc(ctx.db, FILES_COLLECTION, fileId));
  if (!fileDoc.exists()) {
    throw new Error(`File ${fileId} not found`);
  }
  const fileData = fileDoc.data();
  if (fileData.userId !== ctx.userId) {
    throw new Error(`File ${fileId} access denied`);
  }

  // Find the connection document (may not exist for legacy connections)
  const q = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("fileId", "==", fileId),
    where("transactionId", "==", transactionId),
    where("userId", "==", ctx.userId)
  );
  const snapshot = await getDocs(q);

  // Get transaction to check if this is the last file
  const transactionDoc = await getDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
  if (!transactionDoc.exists()) {
    throw new Error(`Transaction ${transactionId} not found`);
  }
  const txData = transactionDoc.data();
  if (txData.userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} access denied`);
  }
  const currentFileIds = txData.fileIds || [];
  const willHaveNoFiles = currentFileIds.length <= 1;
  const hasNoReceiptCategory = !!txData.noReceiptCategoryId;

  const now = Timestamp.now();
  const batch = writeBatch(ctx.db);

  if (!snapshot.empty) {
    const connectionData = snapshot.docs[0].data() as {
      sourceType?: FileSourceType;
      searchPattern?: string;
      gmailIntegrationId?: string;
      resultType?: FileSourceResultType;
    };
    const partnerIdForPattern = txData.partnerId ?? fileData.partnerId ?? null;
    if (
      connectionData.sourceType &&
      connectionData.searchPattern &&
      partnerIdForPattern
    ) {
      try {
        await decrementFileSourcePatternUsage(
          ctx,
          partnerIdForPattern,
          transactionId,
          {
            sourceType: connectionData.sourceType,
            searchPattern: connectionData.searchPattern,
            integrationId: connectionData.gmailIntegrationId,
            resultType: connectionData.resultType,
          }
        );
      } catch (error) {
        console.error("Failed to decrement file source pattern:", error);
      }
    }
  }

  // 1. Delete junction document if it exists
  if (!snapshot.empty) {
    batch.delete(snapshot.docs[0].ref);
  }

  // 2. Update file's transactionIds array
  const fileRef = doc(ctx.db, FILES_COLLECTION, fileId);
  batch.update(fileRef, {
    transactionIds: arrayRemove(transactionId),
    updatedAt: now,
  });

  // 3. Update transaction's fileIds array and potentially mark incomplete
  const transactionRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const transactionUpdate: Record<string, unknown> = {
    fileIds: arrayRemove(fileId),
    updatedAt: now,
  };

  // Mark incomplete only if no files remain AND no no-receipt category
  if (willHaveNoFiles && !hasNoReceiptCategory) {
    transactionUpdate.isComplete = false;
  }

  // If rejecting, add to rejectedFileIds to prevent auto-reconnection
  if (rejectFile) {
    transactionUpdate.rejectedFileIds = arrayUnion(fileId);
  }

  batch.update(transactionRef, transactionUpdate);

  await batch.commit();
}

/**
 * Remove a file from the transaction's rejected list, allowing it to be auto-matched again
 */
export async function unrejectFileFromTransaction(
  ctx: OperationsContext,
  fileId: string,
  transactionId: string
): Promise<void> {
  // Verify transaction exists and belongs to user
  const transactionDoc = await getDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
  if (!transactionDoc.exists()) {
    throw new Error(`Transaction ${transactionId} not found`);
  }
  const txData = transactionDoc.data();
  if (txData.userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} access denied`);
  }

  await updateDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId), {
    rejectedFileIds: arrayRemove(fileId),
    updatedAt: Timestamp.now(),
  });
}

/**
 * Get all files connected to a transaction
 */
export async function getFilesForTransaction(
  ctx: OperationsContext,
  transactionId: string
): Promise<TaxFile[]> {
  // Verify transaction ownership
  const transactionDoc = await getDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
  if (!transactionDoc.exists() || transactionDoc.data().userId !== ctx.userId) {
    return [];
  }

  const fileIds = transactionDoc.data().fileIds || [];
  if (fileIds.length === 0) {
    return [];
  }

  // Fetch all files
  const files: TaxFile[] = [];
  for (const fileId of fileIds) {
    const file = await getFile(ctx, fileId);
    if (file) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Get all connections for a file
 */
export async function getFileConnections(
  ctx: OperationsContext,
  fileId: string
): Promise<FileConnection[]> {
  const q = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("fileId", "==", fileId),
    where("userId", "==", ctx.userId)
  );
  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as FileConnection[];
}

/**
 * Get all transactions connected to a file
 */
export async function getTransactionsForFile(
  ctx: OperationsContext,
  fileId: string
): Promise<Transaction[]> {
  const file = await getFile(ctx, fileId);
  if (!file) {
    return [];
  }

  if (file.transactionIds.length === 0) {
    return [];
  }

  const transactions: Transaction[] = [];
  for (const transactionId of file.transactionIds) {
    const transactionDoc = await getDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
    if (transactionDoc.exists() && transactionDoc.data().userId === ctx.userId) {
      transactions.push({
        id: transactionDoc.id,
        ...transactionDoc.data(),
      } as Transaction);
    }
  }

  return transactions;
}

/**
 * Delete all connections for a file (internal use)
 * Handles both fileConnections documents AND legacy connections where
 * transactions have fileIds but no fileConnections document.
 */
async function deleteFileConnections(
  ctx: OperationsContext,
  fileId: string
): Promise<{ deleted: number }> {
  const now = Timestamp.now();
  let deleted = 0;

  // 1. Delete fileConnections documents and track which transactions were updated
  const connections = await getFileConnections(ctx, fileId);
  const updatedTransactionIds = new Set<string>();

  if (connections.length > 0) {
    const BATCH_SIZE = 500;

    for (let i = 0; i < connections.length; i += BATCH_SIZE) {
      const chunk = connections.slice(i, i + BATCH_SIZE);

      // Delete connection documents
      const deleteBatch = writeBatch(ctx.db);
      for (const conn of chunk) {
        deleteBatch.delete(doc(ctx.db, FILE_CONNECTIONS_COLLECTION, conn.id));
        deleted++;
      }
      await deleteBatch.commit();

      // Update transactions
      for (const conn of chunk) {
        const transactionRef = doc(ctx.db, TRANSACTIONS_COLLECTION, conn.transactionId);
        const transactionSnap = await getDoc(transactionRef);
        if (transactionSnap.exists()) {
          const txData = transactionSnap.data();
          const currentFileIds = (txData.fileIds || []) as string[];
          const remainingFileIds = currentFileIds.filter((id: string) => id !== fileId);

          // Recalculate isComplete: needs files OR noReceiptCategoryId
          const hasFiles = remainingFileIds.length > 0;
          const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
          const isComplete = hasFiles || hasNoReceiptCategory;

          await updateDoc(transactionRef, {
            fileIds: arrayRemove(fileId),
            isComplete,
            updatedAt: now,
          });
          updatedTransactionIds.add(conn.transactionId);
        }
      }
    }
  }

  // 2. Handle legacy connections: check file's transactionIds array
  // and remove fileId from any transactions not already updated
  const fileDoc = await getDoc(doc(ctx.db, FILES_COLLECTION, fileId));
  if (fileDoc.exists()) {
    const fileData = fileDoc.data();
    const transactionIds = (fileData.transactionIds || []) as string[];

    for (const transactionId of transactionIds) {
      // Skip if already updated via fileConnections
      if (updatedTransactionIds.has(transactionId)) {
        continue;
      }

      const transactionRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
      const transactionSnap = await getDoc(transactionRef);
      if (transactionSnap.exists() && transactionSnap.data().userId === ctx.userId) {
        const txData = transactionSnap.data();
        const currentFileIds = (txData.fileIds || []) as string[];
        const remainingFileIds = currentFileIds.filter((id: string) => id !== fileId);

        // Recalculate isComplete: needs files OR noReceiptCategoryId
        const hasFiles = remainingFileIds.length > 0;
        const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
        const isComplete = hasFiles || hasNoReceiptCategory;

        await updateDoc(transactionRef, {
          fileIds: arrayRemove(fileId),
          isComplete,
          updatedAt: now,
        });
        deleted++;
      }
    }
  }

  return { deleted };
}

// === Partner Assignment Operations ===

/**
 * Assign a partner to a file.
 * If the file was previously in manualFileRemovals for this partner (user changed mind),
 * clears it from the removals array.
 */
export async function assignPartnerToFile(
  ctx: OperationsContext,
  fileId: string,
  partnerId: string,
  partnerType: "user" | "global",
  matchedBy: "manual" | "suggestion" | "auto" = "manual",
  confidence?: number
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    partnerId,
    partnerType,
    partnerMatchedBy: matchedBy,
    partnerMatchConfidence: confidence ?? null,
    updatedAt: Timestamp.now(),
  });

  // Remove from manualFileRemovals if this file was previously removed
  // (user changed their mind about the removal)
  try {
    const partnerDocRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
    const partnerSnapshot = await getDoc(partnerDocRef);

    if (partnerSnapshot.exists()) {
      const partnerData = partnerSnapshot.data();
      const manualFileRemovals = (partnerData.manualFileRemovals || []) as ManualFileRemoval[];

      if (manualFileRemovals.some((r) => r.fileId === fileId)) {
        const updatedRemovals = manualFileRemovals.filter((r) => r.fileId !== fileId);
        await updateDoc(partnerDocRef, {
          manualFileRemovals: updatedRemovals,
          updatedAt: Timestamp.now(),
        });
        console.log(
          `[Manual File Removal] Cleared false positive for file ${fileId} (user reassigned)`
        );
      }
    }
  } catch (error) {
    console.error("Failed to clear manual file removal on reassign:", error);
    // Non-critical - don't throw
  }

  // Trigger batch matching for this partner (non-blocking)
  // This will try to match other unmatched files/transactions for the same partner
  if (partnerType === "user") {
    triggerPartnerBatchMatching(partnerId).catch((error) => {
      console.error("Failed to trigger partner batch matching:", error);
    });
  }
}

/**
 * Trigger batch matching for all unmatched files and transactions for a partner.
 * Runs asynchronously - does not block the caller.
 */
async function triggerPartnerBatchMatching(partnerId: string): Promise<void> {
  const { getFunctions, httpsCallable } = await import("firebase/functions");
  const functions = getFunctions(undefined, "europe-west1");
  const matchFn = httpsCallable(functions, "matchFilesForPartner");

  const result = await matchFn({ partnerId });
  const data = result.data as { processed: number; autoMatched: number; suggested: number };

  if (data.autoMatched > 0 || data.suggested > 0) {
    console.log(
      `[Partner Batch Match] Partner ${partnerId}: ${data.autoMatched} auto-matched, ${data.suggested} suggested`
    );
  }
}

/**
 * Remove partner assignment from a file.
 * If the file was auto/suggestion matched, stores the removal as a false positive
 * in the partner's manualFileRemovals array for pattern learning.
 */
export async function removePartnerFromFile(
  ctx: OperationsContext,
  fileId: string
): Promise<void> {
  const existing = await getFile(ctx, fileId);
  if (!existing) {
    throw new Error(`File ${fileId} not found or access denied`);
  }

  const partnerId = existing.partnerId;
  const matchedBy = existing.partnerMatchedBy;

  // Determine if this was a system-recommended assignment
  const wasSystemRecommended = matchedBy === "auto" || matchedBy === "suggestion";

  // Clear the assignment
  const docRef = doc(ctx.db, FILES_COLLECTION, fileId);
  await updateDoc(docRef, {
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    updatedAt: Timestamp.now(),
  });

  // If this was a system-recommended assignment, track as false positive
  if (wasSystemRecommended && partnerId) {
    try {
      const partnerDocRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
      const partnerSnapshot = await getDoc(partnerDocRef);

      if (partnerSnapshot.exists()) {
        const partnerData = partnerSnapshot.data();
        const existingRemovals = (partnerData.manualFileRemovals || []) as ManualFileRemoval[];

        // Check if this file is already in manualFileRemovals
        const alreadyRemoved = existingRemovals.some((r) => r.fileId === fileId);

        if (!alreadyRemoved) {
          const removalEntry: ManualFileRemoval = {
            fileId,
            removedAt: Timestamp.now(),
            extractedPartner: existing.extractedPartner || null,
            fileName: existing.fileName,
          };

          await updateDoc(partnerDocRef, {
            manualFileRemovals: arrayUnion(removalEntry),
            updatedAt: Timestamp.now(),
          });

          console.log(
            `[Manual File Removal] Stored false positive for partner ${partnerId}: file ${fileId}`
          );
        }
      }
    } catch (error) {
      console.error("Failed to store manual file removal:", error);
      // Non-critical - don't throw
    }
  }
}

/**
 * Delete all file connections for a transaction (used when transaction is deleted)
 */
export async function deleteFileConnectionsForTransaction(
  ctx: OperationsContext,
  transactionId: string
): Promise<{ deleted: number }> {
  const q = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("transactionId", "==", transactionId),
    where("userId", "==", ctx.userId)
  );
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return { deleted: 0 };
  }

  const BATCH_SIZE = 500;
  let deleted = 0;
  const now = Timestamp.now();

  for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(ctx.db);
    const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);

    for (const docSnap of chunk) {
      const conn = docSnap.data() as FileConnection;

      // Delete connection document
      batch.delete(docSnap.ref);

      // Update file's transactionIds array
      const fileRef = doc(ctx.db, FILES_COLLECTION, conn.fileId);
      batch.update(fileRef, {
        transactionIds: arrayRemove(transactionId),
        updatedAt: now,
      });

      deleted++;
    }

    await batch.commit();
  }

  return { deleted };
}

// === Integration File Operations ===

/**
 * Soft delete all files for an integration that have NO transaction connections.
 * Files WITH connections are left unchanged (they're still useful).
 *
 * Used when disconnecting a Gmail integration - preserves files that are
 * connected to transactions while hiding orphaned files.
 *
 * @returns Count of files soft-deleted and skipped
 */
export async function softDeleteFilesForIntegration(
  ctx: OperationsContext,
  integrationId: string
): Promise<{ softDeleted: number; skipped: number }> {
  // Query all files for this integration
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("gmailIntegrationId", "==", integrationId)
  );
  const snapshot = await getDocs(q);

  let softDeleted = 0;
  let skipped = 0;
  const now = Timestamp.now();

  const BATCH_SIZE = 500;
  let batch = writeBatch(ctx.db);
  let batchCount = 0;

  for (const fileDoc of snapshot.docs) {
    const data = fileDoc.data();

    // Skip already deleted files
    if (data.deletedAt) {
      continue;
    }

    // Skip files with transaction connections - they're still useful
    if (data.transactionIds && data.transactionIds.length > 0) {
      skipped++;
      continue;
    }

    // Soft delete this file
    batch.update(fileDoc.ref, {
      deletedAt: now,
      updatedAt: now,
    });
    softDeleted++;
    batchCount++;

    // Commit in batches
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = writeBatch(ctx.db);
      batchCount = 0;
    }
  }

  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }

  return { softDeleted, skipped };
}

/**
 * Restore all soft-deleted files for an integration.
 * Called when reconnecting a previously disconnected integration.
 *
 * @returns Count of files restored
 */
export async function restoreFilesForIntegration(
  ctx: OperationsContext,
  integrationId: string
): Promise<{ restored: number }> {
  // Query all files for this integration (including soft-deleted)
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("gmailIntegrationId", "==", integrationId)
  );
  const snapshot = await getDocs(q);

  let restored = 0;
  const now = Timestamp.now();

  const BATCH_SIZE = 500;
  let batch = writeBatch(ctx.db);
  let batchCount = 0;

  for (const fileDoc of snapshot.docs) {
    const data = fileDoc.data();

    // Only restore files that were soft-deleted
    if (!data.deletedAt) {
      continue;
    }

    batch.update(fileDoc.ref, {
      deletedAt: null,
      updatedAt: now,
    });
    restored++;
    batchCount++;

    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = writeBatch(ctx.db);
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  return { restored };
}

// === Bulk Operations ===

/**
 * Bulk soft delete multiple files
 */
export async function bulkSoftDeleteFiles(
  ctx: OperationsContext,
  fileIds: string[]
): Promise<{ deleted: number; errors: string[] }> {
  let deleted = 0;
  const errors: string[] = [];

  for (const fileId of fileIds) {
    try {
      await softDeleteFile(ctx, fileId);
      deleted++;
    } catch (error) {
      errors.push(
        `Failed to delete ${fileId}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  return { deleted, errors };
}

/**
 * Bulk mark files as not invoice
 */
export async function bulkMarkFilesAsNotInvoice(
  ctx: OperationsContext,
  fileIds: string[],
  reason?: string
): Promise<{ updated: number; errors: string[] }> {
  let updated = 0;
  const errors: string[] = [];

  for (const fileId of fileIds) {
    try {
      await markFileAsNotInvoice(ctx, fileId, reason);
      updated++;
    } catch (error) {
      errors.push(
        `Failed to update ${fileId}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  return { updated, errors };
}

/**
 * Bulk unmark files as not invoice (restore as invoice)
 */
export async function bulkUnmarkFilesAsNotInvoice(
  ctx: OperationsContext,
  fileIds: string[]
): Promise<{ updated: number; errors: string[] }> {
  let updated = 0;
  const errors: string[] = [];

  for (const fileId of fileIds) {
    try {
      await unmarkFileAsNotInvoice(ctx, fileId);
      updated++;
    } catch (error) {
      errors.push(
        `Failed to update ${fileId}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  return { updated, errors };
}

// === Agent-Friendly Matching Operations ===

// Re-export TransactionSuggestion from types for convenience
export type { TransactionSuggestion } from "@/types/file";

/**
 * File with transaction suggestions (for agent matching)
 * This is just TaxFile with the optional suggestion fields made explicit
 */
export interface FileWithSuggestions extends TaxFile {
  /** Override to make non-optional for this context */
  transactionMatchComplete: boolean;
}

/**
 * Filters for listing files with suggestions
 */
export interface FileSuggestionsFilters extends FileFilters {
  /** Only files with suggestions */
  hasSuggestions?: boolean;
  /** Minimum confidence for suggestions */
  minSuggestionConfidence?: number;
}

/**
 * List files with their transaction suggestions (from server-side matching).
 * Useful for agents to see what the system has already matched.
 */
export async function listFilesWithSuggestions(
  ctx: OperationsContext,
  filters?: FileSuggestionsFilters & { limit?: number }
): Promise<FileWithSuggestions[]> {
  const constraints: Parameters<typeof query>[1][] = [
    where("userId", "==", ctx.userId),
    orderBy("uploadedAt", "desc"),
  ];

  // Only include files where matching is complete
  constraints.push(where("transactionMatchComplete", "==", true));

  if (filters?.extractionComplete !== undefined) {
    constraints.push(where("extractionComplete", "==", filters.extractionComplete));
  }

  const q = query(collection(ctx.db, FILES_COLLECTION), ...constraints);
  const snapshot = await getDocs(q);

  let files = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
    transactionSuggestions: doc.data().transactionSuggestions || [],
    transactionMatchComplete: doc.data().transactionMatchComplete || false,
  })) as FileWithSuggestions[];

  // Filter out soft-deleted and non-invoice files
  files = files.filter((f) => !f.deletedAt && !f.isNotInvoice);

  // Client-side filters
  if (filters?.search) {
    const searchLower = filters.search.toLowerCase();
    files = files.filter(
      (f) =>
        f.fileName.toLowerCase().includes(searchLower) ||
        (f.extractedPartner?.toLowerCase() || "").includes(searchLower)
    );
  }

  if (filters?.hasConnections !== undefined) {
    files = files.filter((f) =>
      filters.hasConnections
        ? f.transactionIds.length > 0
        : f.transactionIds.length === 0
    );
  }

  // Filter by suggestions
  if (filters?.hasSuggestions !== undefined) {
    files = files.filter((f) =>
      filters.hasSuggestions
        ? (f.transactionSuggestions?.length ?? 0) > 0
        : (f.transactionSuggestions?.length ?? 0) === 0
    );
  }

  // Filter by minimum suggestion confidence
  if (filters?.minSuggestionConfidence !== undefined) {
    files = files.filter((f) =>
      f.transactionSuggestions?.some(
        (s) => s.confidence >= filters.minSuggestionConfidence!
      ) ?? false
    );
  }

  if (filters?.limit) {
    files = files.slice(0, filters.limit);
  }

  return files;
}

/**
 * Filters for listing transactions needing files
 */
export interface TransactionsNeedingFilesFilters {
  /** Minimum amount in cents (absolute value) */
  minAmount?: number;
  /** Only include transactions with a partner assigned */
  hasPartner?: boolean;
  /** Date range start */
  dateFrom?: Date;
  /** Date range end */
  dateTo?: Date;
  /** Max results */
  limit?: number;
}

/**
 * List transactions that need files (no connected files).
 * Useful for agents to know which transactions to find receipts for.
 */
export async function listTransactionsNeedingFiles(
  ctx: OperationsContext,
  filters?: TransactionsNeedingFilesFilters
): Promise<Transaction[]> {
  const constraints: Parameters<typeof query>[1][] = [
    where("userId", "==", ctx.userId),
    orderBy("date", "desc"),
  ];

  // Date range filters
  if (filters?.dateFrom) {
    constraints.push(where("date", ">=", Timestamp.fromDate(filters.dateFrom)));
  }
  if (filters?.dateTo) {
    constraints.push(where("date", "<=", Timestamp.fromDate(filters.dateTo)));
  }

  const q = query(collection(ctx.db, TRANSACTIONS_COLLECTION), ...constraints);
  const snapshot = await getDocs(q);

  let transactions = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Transaction[];

  // Filter to transactions without files
  transactions = transactions.filter(
    (t) => !t.fileIds || t.fileIds.length === 0
  );

  // Filter to transactions without no-receipt category (they actually need files)
  transactions = transactions.filter((t) => !t.noReceiptCategoryId);

  // Filter by amount (absolute value)
  if (filters?.minAmount !== undefined) {
    transactions = transactions.filter(
      (t) => Math.abs(t.amount) >= filters.minAmount!
    );
  }

  // Filter by partner
  if (filters?.hasPartner !== undefined) {
    transactions = transactions.filter((t) =>
      filters.hasPartner ? !!t.partnerId : !t.partnerId
    );
  }

  if (filters?.limit) {
    transactions = transactions.slice(0, filters.limit);
  }

  return transactions;
}

/**
 * Result of auto-connecting suggestions
 */
export interface AutoConnectResult {
  connected: number;
  skipped: number;
  errors: string[];
  connections: Array<{
    fileId: string;
    transactionId: string;
    confidence: number;
  }>;
}

/**
 * Auto-connect files to their suggested transactions above a confidence threshold.
 * Uses the server-side matching results stored in transactionSuggestions.
 *
 * @param fileId - Optional specific file to connect, or all unconnected files if omitted
 * @param minConfidence - Minimum confidence to auto-connect (default 89, matches server threshold)
 */
export async function autoConnectFileSuggestions(
  ctx: OperationsContext,
  fileId?: string,
  minConfidence: number = 89
): Promise<AutoConnectResult> {
  const result: AutoConnectResult = {
    connected: 0,
    skipped: 0,
    errors: [],
    connections: [],
  };

  // Get files to process
  let files: FileWithSuggestions[];
  if (fileId) {
    const file = await getFile(ctx, fileId);
    if (!file) {
      result.errors.push(`File ${fileId} not found`);
      return result;
    }
    files = [{
      ...file,
      transactionSuggestions: (file as unknown as { transactionSuggestions?: TransactionSuggestion[] }).transactionSuggestions || [],
      transactionMatchComplete: (file as unknown as { transactionMatchComplete?: boolean }).transactionMatchComplete || false,
    }];
  } else {
    // Get all unconnected files with suggestions
    files = await listFilesWithSuggestions(ctx, {
      hasConnections: false,
      hasSuggestions: true,
      minSuggestionConfidence: minConfidence,
    });
  }

  // Process each file
  for (const file of files) {
    // Skip files already connected
    if (file.transactionIds.length > 0) {
      result.skipped++;
      continue;
    }

    // Find highest-confidence suggestion above threshold
    const bestSuggestion = (file.transactionSuggestions ?? [])
      .filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!bestSuggestion) {
      result.skipped++;
      continue;
    }

    // Connect the file to the transaction
    try {
      await connectFileToTransaction(
        ctx,
        file.id,
        bestSuggestion.transactionId,
        "auto_matched",
        bestSuggestion.confidence
      );

      result.connected++;
      result.connections.push({
        fileId: file.id,
        transactionId: bestSuggestion.transactionId,
        confidence: bestSuggestion.confidence,
      });
    } catch (error) {
      result.errors.push(
        `Failed to connect ${file.id}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  return result;
}
