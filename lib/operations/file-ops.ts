import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  Timestamp,
  arrayUnion,
} from "firebase/firestore";
import {
  TaxFile,
  FileFilters,
  FileCreateData,
  ExtractedLineItem,
  TransactionSuggestion,
} from "@/types/file";
import { Transaction } from "@/types/transaction";
import { FileSourceResultType, FileSourceType, ManualFileRemoval } from "@/types/partner";
import { OperationsContext } from "./types";
import { liveCopies } from "@/lib/files/copy-state";
import { callFunction } from "@/lib/firebase/callable";
import { fileDocumentAmount, fileDocumentVatAmount } from "@/lib/files/document-amount";

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
  mailMessageId?: string;
  /** For Gmail: sender email */
  gmailMessageFrom?: string;
  /** For Gmail: sender name */
  gmailMessageFromName?: string;
  /** Type of result selected during the connection */
  resultType?: FileSourceResultType;
}

const FILES_COLLECTION = "files";
const TRANSACTIONS_COLLECTION = "transactions";

function normalizeFileMonetaryFields(file: TaxFile): TaxFile {
  const lineItems = file.extractedLineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return file;
  }

  return {
    ...file,
    extractedAmount: fileDocumentAmount(file),
    extractedVatAmount: fileDocumentVatAmount(file),
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

  // A purged File is destroyed (#268): its skeleton record exists only for
  // deduplication and is never listed, whatever the filters say.
  files = files.filter((f) => !f.purgedAt);

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
 * Create a new file record (after uploading to storage).
 *
 * Through the callable rather than straight to Firestore, because the write is
 * where the duplicate check lives (#182). A client-side check-then-write holds
 * the whole upload open between the read and the write, so two runs of the same
 * drop both find nothing and both create a File. The server checks as it
 * writes; when the bytes are already on file it creates nothing and hands back
 * the File that has them, which is the id this returns.
 */
export async function createFile(
  ctx: OperationsContext,
  data: FileCreateData
): Promise<string> {
  const result = await callFunction<
    { data: Record<string, unknown> },
    { fileId: string; duplicate: boolean }
  >("createFile", {
    data: {
      ...data,
      // The callable takes the two date fields over the wire as ISO strings.
      gmailEmailDate: data.gmailEmailDate?.toISOString(),
      inboundReceivedAt: data.inboundReceivedAt?.toISOString(),
    },
  });

  return result.fileId;
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
 * Update the invoice direction for a file (#233).
 *
 * Through the callable rather than straight to Firestore, because setting the
 * direction is not just a field write: it decides whether the document counts
 * as one the user issued, which moves the § 11 classification, and it can
 * resolve or create a disagreement with the transactions the file is attached
 * to. It also has to leave a provenance mark, so a later re-extraction refuses
 * the file instead of quietly undoing the person's ruling. All of that is
 * domain logic, and the server already owns it.
 */
export async function updateFileDirection(
  ctx: OperationsContext,
  fileId: string,
  direction: "incoming" | "outgoing" | "unknown"
): Promise<void> {
  await callFunction<
    { fileId: string; data: { invoiceDirection: "incoming" | "outgoing" | "unknown" } },
    { success: boolean }
  >("updateFile", { fileId, data: { invoiceDirection: direction } });
}

/**
 * Editable additional field (label + value pair)
 */
export interface EditableAdditionalField {
  /** Canonical extraction key (#252), carried through a save unchanged. */
  key?: string;
  label: string;
  value: string;
}

export interface EditableLineItem {
  description: string;
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
  /**
   * Trinkgeld the document does not print (#217), in currency units. Empty is
   * "no tip" — and it is seeded from the stored value, so a tip the Beleg DID
   * print survives a save that did not touch this box.
   */
  tipAmount: string;
  /**
   * The tip above is not printed on the invoice (#310), so the server does not
   * measure it against the document total (#554). Absent is false: the default
   * bound is the document's own total.
   */
  tipNotPrinted?: boolean;
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

      return {
        description: item.description.trim() || `Item ${index + 1}`,
        vatPercent,
        vatAmount,
        amount,
      };
    })
    .filter((item): item is ExtractedLineItem => item !== null);
}

/**
 * Save the file detail panel's extracted-fields form (#149).
 *
 * Delegates to the `updateFileExtractedFields` callable rather than writing the
 * file document here. A hand correction is not "put these values in the
 * record": it also has to stamp `extractionCorrectedFields` /
 * `extractionCorrectedAt`, which is what `retry_file_extraction` refuses on
 * (#147/#184) and what a re-extraction sweep reads to build its exclusion
 * list. Those stamps are built in exactly one place,
 * the File facts module on the server, shared by the callable and the
 * MCP tool. A client-side copy would be a second writer of the same rule, and
 * the rule includes the comparison of what actually moved — this form posts
 * every field on every save, so without that comparison a save that typed
 * nothing would mark the file hand-corrected on all five fields.
 *
 * Until this delegated, a correction made by an agent survived the next
 * re-extraction and the same correction typed by a person did not.
 *
 * What stays here is the form's own concern: turning boxes of text into typed
 * values. Two rules of the old direct write are preserved deliberately — an
 * empty box clears the stored value, and a box that cannot be parsed is left
 * out entirely rather than clearing a good figure.
 *
 * `ctx` is unused: the callable resolves the caller from the auth token and
 * enforces ownership server-side. It stays in the signature because every
 * operation in this module takes it.
 */
export async function updateFileExtractedFields(
  ctx: OperationsContext,
  fileId: string,
  fields: EditableExtractedFields
): Promise<void> {
  const correction: Record<string, unknown> = {};

  if (fields.date) {
    const dateObj = new Date(fields.date);
    if (!isNaN(dateObj.getTime())) {
      correction.date = dateObj.toISOString().slice(0, 10);
    }
  } else {
    correction.date = null;
  }

  const normalizedLineItems = normalizeEditableLineItems(fields.lineItems);
  const hasLineItems = fields.lineItems !== undefined && normalizedLineItems.length > 0;

  // #203: only what the person actually stated goes over as a correction.
  // This used to send a total and VAT CONSOLIDATED FROM THE ROWS whenever the
  // itemisation was present — a derived figure posted as if a person had ruled
  // on it. On a file whose rows disagree with its document total (a skipped
  // discount row), that overwrote the stored total with the row sum and
  // stamped the wrong value as hand-corrected, which a re-extraction then
  // refused to repair. The amount and rate boxes go over as typed; the
  // top-level VAT is not sent at all when rows exist, because every consumer
  // derives VAT from the rows first and the builder must never receive a
  // derivation dressed as a ruling.
  if (hasLineItems) {
    correction.lineItems = normalizedLineItems;
  } else if (fields.lineItems !== undefined) {
    correction.lineItems = null;
    correction.vatAmount = null;
  }

  if (fields.amount) {
    const amountNum = parseNumberInput(fields.amount);
    if (amountNum !== null) {
      correction.amount = Math.round(amountNum * 100);
    }
  } else {
    correction.amount = null;
  }

  // #217: sent beside the amount, never taken out of it. On a document whose
  // total never included the tip, that total already is the VAT base — a
  // subtraction here would shrink it and under-claim the return.
  if (fields.tipAmount) {
    const tipNum = parseNumberInput(fields.tipAmount);
    if (tipNum !== null) {
      correction.tipAmount = Math.round(tipNum * 100);
    }
  } else {
    correction.tipAmount = null;
  }

  if (fields.vatPercent) {
    const vatNum = parseNumberInput(fields.vatPercent);
    if (vatNum !== null) {
      correction.vatPercent = vatNum;
    }
  } else {
    correction.vatPercent = null;
  }

  const additionalFields = fields.additionalFields
    .filter((f) => f.label.trim() && f.value.trim())
    .map((f) => ({
      ...(f.key ? { key: f.key } : {}),
      label: f.label.trim(),
      value: f.value.trim(),
      rawValue: f.value.trim(), // use edited value as raw
    }));

  await callFunction<
    {
      fileId: string;
      correction: Record<string, unknown>;
      tipNotPrinted: boolean;
      details: Record<string, unknown>;
    },
    { success: boolean; changed: string[]; correctedFields: string[] }
  >("updateFileExtractedFields", {
    fileId,
    correction,
    // #310: beside the correction, not inside it — it says how to read the tip
    // rather than being a value the record keeps per field.
    tipNotPrinted: fields.tipNotPrinted === true,
    details: {
      partner: fields.partner || null,
      vatId: fields.vatId || null,
      iban: fields.iban || null,
      address: fields.address || null,
      additionalFields: additionalFields.length > 0 ? additionalFields : null,
    },
  });
}

/**
 * Retry extraction for a file that had an error
 * Calls the Cloud Function to re-run extraction
 * @param force - If true, bypasses checks and forces re-extraction (used to upgrade old files)
 * @param options.overwriteCorrections - The forced re-extraction of a File with
 *   a Hand Correction, after the person confirmed it (#639). Without it the
 *   server refuses such a File with `{ code: "HAND_CORRECTED", fields }`.
 */
export async function retryFileExtraction(
  ctx: OperationsContext,
  fileId: string,
  force?: boolean,
  options: { overwriteCorrections?: boolean } = {}
): Promise<void> {
  const { getFunctions, httpsCallable } = await import("firebase/functions");
  const functions = getFunctions(undefined, "europe-west1");
  const retryFn = httpsCallable(functions, "retryFileExtraction");
  await retryFn({
    fileId,
    force,
    ...(options.overwriteCorrections ? { overwriteCorrections: true } : {}),
  });
}

// === File-Transaction Connection Operations ===

/**
 * Connect a file to a transaction (many-to-many). The connect callable does
 * the work, so every screen gets its Copy refusal, the payee rule and the
 * record a disconnect reverts (#584).
 */
export async function connectFileToTransaction(
  _ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  connectionType: "manual" | "auto_matched" = "manual",
  matchConfidence?: number,
  sourceInfo?: FileConnectionSourceInfo
): Promise<string> {
  const result = await callFunction<
    {
      fileId: string;
      transactionId: string;
      connectionType: "manual" | "auto_matched";
      matchConfidence?: number;
      sourceInfo?: FileConnectionSourceInfo;
    },
    { connectionId: string }
  >("connectFileToTransaction", {
    fileId,
    transactionId,
    connectionType,
    ...(matchConfidence !== undefined ? { matchConfidence } : {}),
    ...(sourceInfo ? { sourceInfo } : {}),
  });
  return result.connectionId;
}

/**
 * Disconnect a file from a transaction, through the disconnect callable
 * (#584): it derives a Partner the payee rule filled from the remaining Files.
 * @param rejectFile If true, adds the file to transaction's rejectedFileIds to prevent auto-reconnection
 */
export async function disconnectFileFromTransaction(
  _ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  rejectFile: boolean = false
): Promise<void> {
  await callFunction("disconnectFileFromTransaction", { fileId, transactionId, rejectFile });
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

// === Bulk Operations ===

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

  // Filter out soft-deleted and non-invoice files, and Copies (#162): a Copy
  // is never work. Its original may sit outside this query, so it is read.
  const listed = new Set(files.map((f) => f.id));
  const missingOriginalIds = [
    ...new Set(files.map((f) => f.copyOfFileId).filter((id): id is string => !!id && !listed.has(id))),
  ];
  const missingOriginals = await Promise.all(
    missingOriginalIds.map((id) => getDoc(doc(ctx.db, FILES_COLLECTION, id)))
  );
  const copies = liveCopies([
    ...files,
    ...missingOriginals
      .filter((snap) => snap.exists())
      .map((snap) => ({ id: snap.id, ...(snap.data() as Pick<TaxFile, "deletedAt" | "purgedAt">) })),
  ]);
  files = files.filter((f) => !f.deletedAt && !f.isNotInvoice && !copies.has(f.id));

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

