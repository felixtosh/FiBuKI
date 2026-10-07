/**
 * Precision Search Queue Processor
 *
 * Processes precision receipt search requests, running multiple strategies
 * to find and connect receipts to incomplete transactions.
 *
 * Follows the same pattern as gmailSyncQueue.ts:
 * - Queue-based processing with pagination
 * - Timeout handling with continuation
 * - Both scheduled (cron) and immediate (onCreate) processing
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { isTransactionDismissed } from "../matching/dismissedTransactions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import { analyzeEmailForInvoice } from "./geminiSearchHelper";
import { isFileRejected } from "../matching/rejectedFiles";
import { runTransactionMatching } from "../matching/matchFileTransactions";
import { calculateAmountScore, isLocalFileStrategy } from "../matching/transactionScoring";
import { filePaymentTotal } from "../matching/coverage";
import { readBankOriginalAmount } from "../fx/bankOriginalAmount";
import { generateTypedQueriesWithGemini } from "./generateQueriesWithGemini";
import {
  expectedInvoiceWindow,
  QueryGenerationPartner,
  SearchDateWindow,
} from "./generateSearchQueries";
import { ResolvedEffectiveCycle } from "../matching/billingCycle";
import { convertHtmlToPdf } from "./htmlToPdf";
import { createFileRecord } from "../files/createFileRecord";
import {
  scoreAttachmentMatch,
  ScoreAttachmentInput,
  ATTACHMENT_MATCH_THRESHOLD,
  GREAT_MATCH_THRESHOLD,
  GREAT_MATCH_COUNT,
} from "./scoreAttachmentMatch";
import {
  classifyEmail,
  GmailAttachment,
} from "./shared-utils";
import { activityEntry, logActivity } from "../utils/activity";
import type { MailMessage, MailSearchLimitation } from "../mail/provider";
import { namedSearchTerms } from "../mail/search-terms";
import { searchedMailIntegrations, SEARCHABLE_MAIL_PROVIDERS, mailProviderOf } from "../mail/searchable";
import {
  MAIL_PROVIDER_SECRETS,
  SearchedMailbox,
  closeSearchedMailboxes,
  MailboxReadError,
  failMailbox,
  fromMailbox,
  isUsable,
  openSearchedMailboxes,
} from "../mail/searchMailboxes";

const db = getFirestore();
const storage = getStorage();

// ============================================================================
// Constants
// ============================================================================

const PROCESSING_TIMEOUT_MS = 240000; // 4 minutes (leave buffer for 5 min timeout)
const TRANSACTIONS_PER_BATCH = 20; // Process 20 transactions per invocation
const PENDING_ITEMS_PER_RUN = 10; // Paused items the scheduled run may move past

// Strategy execution order (used when creating queue items)
// email_invoice before email_attachment: prioritize finding the actual invoice email
export const DEFAULT_STRATEGIES: SearchStrategy[] = [
  "partner_files",
  "amount_files",
  "email_invoice",
  "email_attachment",
];

// ============================================================================
// Types (simplified versions for Cloud Function use)
// ============================================================================

type SearchStrategy =
  | "partner_files"
  | "amount_files"
  | "email_attachment"
  | "email_invoice";

type PrecisionSearchStatus = "pending" | "processing" | "completed" | "failed";

interface PrecisionSearchQueueItem {
  id: string;
  userId: string;
  scope: "all_incomplete" | "single_transaction";
  transactionId?: string;
  triggeredBy: "gmail_sync" | "manual" | "scheduled";
  triggeredByAuthor?: {
    type: string;
    userId: string;
    sessionId?: string;
    toolCallId?: string;
  };
  gmailSyncQueueId?: string;
  status: PrecisionSearchStatus;
  transactionsToProcess: number;
  transactionsProcessed: number;
  transactionsWithMatches: number;
  totalFilesConnected: number;
  lastProcessedTransactionId?: string;
  strategies: SearchStrategy[];
  currentStrategyIndex: number;
  errors: string[];
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

interface Transaction {
  id: string;
  userId: string;
  date: Timestamp;
  amount: number;
  currency: string;
  name: string;
  partner: string | null;
  partnerId: string | null;
  partnerType: "global" | "user" | null;
  partnerIban?: string | null;
  isComplete: boolean;
  fileIds?: string[];
  rejectedFileIds?: string[];
  description?: string;
  reference?: string;
  /** The importer's preserved CSV row; carries the bank-stated original (#112). */
  _original?: { rawRow?: Record<string, string> | null } | null;
}

/** The bank-stated original amount in cents, for the email scorer (#555). */
function originalAmountOf(transaction: Transaction): number | null {
  return readBankOriginalAmount(transaction._original?.rawRow)?.amount ?? null;
}

interface TaxFile {
  id: string;
  userId: string;
  fileName?: string;
  fileType?: string;
  extractedDate?: Timestamp;
  extractedAmount?: number;
  extractedPartner?: string;
  extractedIban?: string;
  extractedText?: string;
  extractedCurrency?: string;
  extractedTipAmount?: number | null;
  partnerId?: string;
  transactionIds?: string[];
  transactionMatchComplete?: boolean;
  precisionSearchHint?: { searchStrategy?: string } | null;
  deletedAt?: Timestamp | null;
}

interface FileSourcePattern {
  sourceType: "local" | "gmail";
  pattern: string;
  confidence: number;
  usageCount: number;
}

interface Partner {
  id: string;
  name: string;
  emailDomains?: string[];
  website?: string;
  ibans?: string[];
  vatId?: string;
  aliases?: string[];
  fileSourcePatterns?: FileSourcePattern[];
  billingCycle?: { effective?: ResolvedEffectiveCycle[] };
}

/**
 * Whether the search waits for a mailbox that needs new credentials.
 *
 * Any Mail Provider (#746): the search runs once per Transaction, so a search
 * that went ahead without the mailbox would never look there again after the
 * repair. It pauses instead and resumes once the mailbox is reconnected.
 */
async function shouldPauseForMailReauth(userId: string): Promise<{
  shouldPause: boolean;
  reason?: string;
  integrationEmail?: string;
}> {
  const needsReauthSnapshot = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .where("needsReauth", "==", true)
    .get();

  const waiting = needsReauthSnapshot.docs.find((doc) =>
    (SEARCHABLE_MAIL_PROVIDERS as readonly string[]).includes(mailProviderOf(doc.data()))
  );
  if (waiting) {
    return {
      shouldPause: true,
      reason: "A mailbox needs new credentials",
      integrationEmail: waiting.data().email as string | undefined,
    };
  }

  return { shouldPause: false };
}

/**
 * Whether the receipt search reads any of the User's Mail Integrations. If
 * not, the email strategies are skipped and no Gemini call is spent on them.
 */
async function hasSearchableMailIntegration(userId: string): Promise<boolean> {
  const snapshot = await db.collection("emailIntegrations").where("userId", "==", userId).get();
  return searchedMailIntegrations(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))).length > 0;
}


interface SearchAttempt {
  strategy: SearchStrategy;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  searchParams: Record<string, unknown>;
  candidatesFound: number;
  candidatesEvaluated: number;
  matchesFound: number;
  fileIdsConnected: string[];
  /**
   * Stored Files a local-file strategy nominated this Transaction to (#589).
   * A nomination is not a connection: the ones the matcher connected are in
   * `fileIdsConnected` as well.
   */
  fileIdsNominated?: string[];
  bestMatchScore?: number; // Track the best score to decide if we should stop searching
  invoiceLinksFound?: string[];
  /**
   * Search constraints a Mail Provider could not execute as asked (#746), per
   * mailbox: an IMAP server that refused the keyword search, a filename it
   * cannot search. The results were wider or scanned, never silently narrower.
   */
  mailLimitations?: Array<{ integrationId: string } & MailSearchLimitation>;
  geminiCalls?: number;
  geminiTokensUsed?: number;
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A deleted File that was Split into parts (#550). */
function hasSplitParts(fileData: FirebaseFirestore.DocumentData): boolean {
  return Array.isArray(fileData.splitInto) && fileData.splitInto.length > 0;
}

async function sha256(data: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function extractEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return email.toLowerCase();
  return email.substring(atIndex + 1).toLowerCase();
}

/**
 * Check if email date is within acceptable range of transaction date
 */
function isEmailDateInRange(emailDate: Date, transactionDate: Date, daysRange: number = 180): boolean {
  const diffMs = Math.abs(emailDate.getTime() - transactionDate.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= daysRange;
}

/**
 * Check if a file was rejected by the transaction (user manually removed it).
 *
 * Reads both stored shapes through matching/rejectedFiles: this used to consult
 * the legacy id array alone, so a rejection recorded only as a `rejectedFiles`
 * record was invisible here and the pair was re-queued (fork #102).
 */
function isFileRejectedByTransaction(fileId: string, transaction: Transaction): boolean {
  return isFileRejected(transaction, fileId);
}

/**
 * Check if an attachment is likely a receipt/invoice based on filename and MIME type
 * For automation, we only consider PDFs - images in emails are usually logos/signatures
 */
function isLikelyReceiptAttachment(filename: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  const filenameLower = filename.toLowerCase();

  // Only PDFs for automation - images in emails are typically logos/signatures, not receipts
  return normalizedMime === "application/pdf" ||
    (normalizedMime === "application/octet-stream" && filenameLower.endsWith(".pdf"));
}

// ============================================================================
// Email Classification - imported from ./shared-utils
// classifyEmail, EmailClassification, MAIL_INVOICE_KEYWORDS, INVOICE_LINK_KEYWORDS
// ============================================================================

/** A message's invoice-type attachments, as the classifier and the filer read them. */
function receiptAttachments(message: MailMessage): GmailAttachment[] {
  return message.attachments.map((a) => ({
    attachmentId: a.attachmentId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    isLikelyReceipt: isLikelyReceiptAttachment(a.filename, a.mimeType),
  }));
}

/** How far from the charge a mail may be dated and still be its receipt. */
const MAIL_WINDOW_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The mail search window around a charge. Searched server-side, where the
 * strategies used to filter by it only after fetching: a mailbox returns its
 * newest matches first, so a window on the server keeps every match the
 * after-the-fact filter kept and finds older ones a full page of newer mail
 * used to push out.
 */
function mailWindow(txDate: Date): { dateFrom: Date; dateTo: Date } {
  return {
    dateFrom: new Date(txDate.getTime() - MAIL_WINDOW_DAYS * MS_PER_DAY),
    dateTo: new Date(txDate.getTime() + MAIL_WINDOW_DAYS * MS_PER_DAY),
  };
}

/** Keep each constraint a provider could not execute once per mailbox, on the attempt. */
function noteLimitations(
  attempt: SearchAttempt,
  mailbox: SearchedMailbox,
  limitations: MailSearchLimitation[] | undefined
): void {
  for (const limitation of limitations ?? []) {
    const noted = (attempt.mailLimitations ??= []);
    if (noted.some((n) => n.integrationId === mailbox.id && n.constraint === limitation.constraint)) continue;
    noted.push({ integrationId: mailbox.id, ...limitation });
  }
}

/**
 * Files already made from this mail part in this mailbox. An IMAP message id
 * is a UID, unique only within its mailbox, so the mailbox is part of the key;
 * a File recorded without one (made before mailboxes were told apart) still
 * counts.
 */
async function filesFromMailPart(
  userId: string,
  mailbox: SearchedMailbox,
  messageId: string,
  where: { attachmentId?: string; sourceType?: string }
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  let query = db
    .collection("files")
    .where("userId", "==", userId)
    .where("mailMessageId", "==", messageId);
  if (where.attachmentId) query = query.where("mailAttachmentId", "==", where.attachmentId);
  if (where.sourceType) query = query.where("sourceType", "==", where.sourceType);
  const snap = await query.get();
  return snap.docs.filter((doc) => {
    const owner = doc.data().gmailIntegrationId;
    return !owner || owner === mailbox.id;
  });
}

interface PrecisionSearchHint {
  transactionId: string;
  transactionAmount: number;
  transactionDate: Timestamp;
  searchStrategy: SearchStrategy;
  searchedAt: Timestamp;
}

/**
 * Create a file from email attachment data
 * Note: Files are created WITHOUT connecting to transactions.
 * The matchFileTransactions trigger handles matching after extraction.
 */
async function createFileFromAttachment(
  userId: string,
  attachmentData: Buffer,
  attachment: GmailAttachment,
  message: MailMessage,
  integrationId: string,
  integrationEmail?: string,
  precisionSearchHint?: PrecisionSearchHint
): Promise<string | null> {
  const contentHash = await sha256(attachmentData);
  const messageId = message.id;

  // Check for duplicate (including soft-deleted files)
  const existingFile = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("contentHash", "==", contentHash)
    .limit(1)
    .get();

  if (!existingFile.empty) {
    const existingDoc = existingFile.docs[0];
    const existingData = existingDoc.data();

    // Check if file was soft-deleted. A Split original stays deleted (#550):
    // its parts document the payment, and undeleting it would do so twice.
    if (existingData.deletedAt && !hasSplitParts(existingData)) {
      // Undelete the file and update its metadata + add precision search hint
      console.log(`[PrecisionSearch] Undeleting soft-deleted file: ${attachment.filename} (${existingDoc.id})`);

      // Fix storage metadata if needed (old files may have wrong MIME type)
      const storagePath = existingData.storagePath;
      if (storagePath) {
        const filenameLower = attachment.filename.toLowerCase();
        let correctContentType = attachment.mimeType;

        // Normalize MIME type based on extension
        if (correctContentType === "application/octet-stream") {
          if (filenameLower.endsWith(".pdf")) {
            correctContentType = "application/pdf";
          } else if (filenameLower.endsWith(".jpg") || filenameLower.endsWith(".jpeg")) {
            correctContentType = "image/jpeg";
          } else if (filenameLower.endsWith(".png")) {
            correctContentType = "image/png";
          }
        }

        // Update storage metadata to fix MIME type
        try {
          const bucket = storage.bucket();
          const storageFile = bucket.file(storagePath);
          await storageFile.setMetadata({
            contentType: correctContentType,
            contentDisposition: "inline",
          });
          console.log(`[PrecisionSearch] Fixed storage metadata for ${attachment.filename}: ${correctContentType}`);
        } catch (err) {
          console.error(`[PrecisionSearch] Failed to fix storage metadata:`, err);
        }
      }

      const updateData: Record<string, unknown> = {
        deletedAt: null,
        // The log (#752): a deleted File brought back by the search.
        ...logActivity(activityEntry({
          type: "file_restored",
          actor: "auto",
          transactionId: precisionSearchHint?.transactionId ?? null,
          summary: "Restored: the receipt search found this deleted File again",
        })),
        fileName: attachment.filename,
        fileType: attachment.mimeType === "application/octet-stream" && attachment.filename.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : attachment.mimeType,
        extractionComplete: false, // Re-trigger extraction
        extractionError: null,
        updatedAt: Timestamp.now(),
      };
      // Add precision search hint to trigger matching
      if (precisionSearchHint) {
        updateData.precisionSearchHint = precisionSearchHint;
        updateData.transactionMatchComplete = false; // Re-trigger matching
      }
      await existingDoc.ref.update(updateData);
      return `existing:${existingDoc.id}`;
    }

    // File exists and is not deleted - return the existing file ID with "existing:" prefix
    // so the caller can score it instead of skipping
    console.log(`[PrecisionSearch] File exists by hash: ${attachment.filename} (${existingDoc.id})`);
    return `existing:${existingDoc.id}`;
  }

  // Extract email metadata
  const from = message.from;
  const subject = message.subject;
  const emailDate = message.date;
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = emailMatch[1] || from;
  const senderDomain = extractEmailDomain(senderEmail);
  const senderName = from.split("<")[0].trim().replace(/"/g, "");

  // Upload to Storage (matching UI's gmail/attachment route.ts pattern)
  const timestamp = Date.now();
  const sanitizedFilename = attachment.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const storagePath = `files/${userId}/${timestamp}_${sanitizedFilename}`;
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  // Fix MIME type if it's generic but we can infer from filename
  // This is common for Gmail attachments which often have application/octet-stream
  let contentType = attachment.mimeType;
  const filenameLower = attachment.filename.toLowerCase();
  if (contentType === "application/octet-stream") {
    if (filenameLower.endsWith(".pdf")) {
      contentType = "application/pdf";
    } else if (filenameLower.endsWith(".jpg") || filenameLower.endsWith(".jpeg")) {
      contentType = "image/jpeg";
    } else if (filenameLower.endsWith(".png")) {
      contentType = "image/png";
    } else if (filenameLower.endsWith(".webp")) {
      contentType = "image/webp";
    } else if (filenameLower.endsWith(".gif")) {
      contentType = "image/gif";
    }
  }

  // Generate download token BEFORE saving (same as UI)
  const downloadToken = crypto.randomUUID();

  // Save with all metadata in one call (same pattern as UI's gmail/attachment route)
  await file.save(attachmentData, {
    metadata: {
      contentType,
      contentDisposition: "inline",
      metadata: {
        originalName: attachment.filename,
        mailMessageId: messageId,
        gmailIntegrationId: integrationId,
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  // Generate download URL
  const downloadUrl = buildDownloadUrl(bucket.name, storagePath, downloadToken);

  // Create file document
  const now = Timestamp.now();
  const fileData: Record<string, unknown> = {
    userId,
    fileName: attachment.filename,
    fileType: contentType, // Use corrected MIME type
    // The stored bytes, not the provider's figure: IMAP reports the encoded
    // part's size (#722).
    fileSize: attachmentData.length,
    storagePath,
    downloadUrl,
    contentHash,
    sourceType: "gmail",
    mailMessageId: messageId,
    gmailIntegrationId: integrationId,
    gmailIntegrationEmail: integrationEmail,
    gmailSubject: subject,
    mailAttachmentId: attachment.attachmentId,
    gmailSenderEmail: senderEmail,
    gmailSenderDomain: senderDomain,
    gmailSenderName: senderName,
    gmailEmailDate: Timestamp.fromDate(emailDate),
    extractionComplete: false,
    transactionIds: [],
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Add precision search hint for matching logic
  if (precisionSearchHint) {
    fileData.precisionSearchHint = precisionSearchHint;
  }

  // Through the shared write point (#182): the duplicate branch above is a
  // read taken before the download and the storage upload, so a concurrent
  // search can create the File in between.
  const { fileId } = await createFileRecord(db, fileData);

  console.log(`[PrecisionSearch] Created file: ${attachment.filename} (${fileId})${precisionSearchHint ? ` [hint: tx ${precisionSearchHint.transactionId}]` : ""}`);
  return fileId;
}

/**
 * Create a file from HTML-converted PDF
 * Note: Files are created WITHOUT connecting to transactions.
 * The matchFileTransactions trigger handles matching after extraction.
 */
async function createFileFromHtmlPdf(
  userId: string,
  pdfBuffer: Buffer,
  filename: string,
  message: MailMessage,
  integrationId: string,
  integrationEmail?: string,
  precisionSearchHint?: PrecisionSearchHint
): Promise<string | null> {
  const contentHash = await sha256(pdfBuffer);

  // Check for duplicate (including soft-deleted files)
  const existingFile = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("contentHash", "==", contentHash)
    .limit(1)
    .get();

  if (!existingFile.empty) {
    const existingDoc = existingFile.docs[0];
    const existingData = existingDoc.data();

    // Check if file was soft-deleted. A Split original stays deleted (#550):
    // its parts document the payment, and undeleting it would do so twice.
    if (existingData.deletedAt && !hasSplitParts(existingData)) {
      // Undelete the file and update its metadata + add precision search hint
      console.log(`[PrecisionSearch] Undeleting soft-deleted PDF: ${filename} (${existingDoc.id})`);
      const updateData: Record<string, unknown> = {
        deletedAt: null,
        // The log (#752): a deleted File brought back by the search.
        ...logActivity(activityEntry({
          type: "file_restored",
          actor: "auto",
          transactionId: precisionSearchHint?.transactionId ?? null,
          summary: "Restored: the receipt search found this deleted File again",
        })),
        fileName: filename,
        updatedAt: Timestamp.now(),
      };
      // Add precision search hint to trigger matching
      if (precisionSearchHint) {
        updateData.precisionSearchHint = precisionSearchHint;
        updateData.transactionMatchComplete = false; // Re-trigger matching
      }
      await existingDoc.ref.update(updateData);
      return `existing:${existingDoc.id}`;
    }

    console.log(`[PrecisionSearch] Duplicate PDF skipped: ${filename}`);
    return null;
  }

  // Extract email metadata
  const from = message.from;
  const subject = message.subject;
  const emailDate = message.date;
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = emailMatch[1] || from;
  const senderDomain = extractEmailDomain(senderEmail);
  const senderName = from.split("<")[0].trim().replace(/"/g, "");

  // Upload to Storage (matching UI's gmail/attachment route.ts pattern)
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const storagePath = `files/${userId}/${timestamp}_${sanitizedFilename}`;
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  // Generate download token BEFORE saving (same as UI)
  const downloadToken = crypto.randomUUID();

  // Save with all metadata in one call (same pattern as UI)
  await file.save(pdfBuffer, {
    metadata: {
      contentType: "application/pdf",
      contentDisposition: "inline",
      metadata: {
        originalName: filename,
        mailMessageId: message.id,
        gmailIntegrationId: integrationId,
        convertedFromHtml: "true",
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  // Generate download URL
  const downloadUrl = buildDownloadUrl(bucket.name, storagePath, downloadToken);

  // Create file document
  const now = Timestamp.now();
  const fileData: Record<string, unknown> = {
    userId,
    fileName: filename,
    fileType: "application/pdf",
    fileSize: pdfBuffer.length,
    storagePath,
    downloadUrl,
    contentHash,
    sourceType: "gmail_html_invoice",
    mailMessageId: message.id,
    gmailIntegrationId: integrationId,
    gmailIntegrationEmail: integrationEmail,
    gmailSubject: subject,
    gmailSenderEmail: senderEmail,
    gmailSenderDomain: senderDomain,
    gmailSenderName: senderName,
    gmailEmailDate: Timestamp.fromDate(emailDate),
    extractionComplete: false,
    transactionIds: [],
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Add precision search hint for matching logic
  if (precisionSearchHint) {
    fileData.precisionSearchHint = precisionSearchHint;
  }

  const { fileId } = await createFileRecord(db, fileData);

  console.log(`[PrecisionSearch] Created HTML-converted PDF: ${filename} (${fileId})${precisionSearchHint ? ` [hint: tx ${precisionSearchHint.transactionId}]` : ""}`);
  return fileId;
}

// ============================================================================
// Billing-cycle date window (#169)
// ============================================================================

/**
 * Where this charge's document is expected to be dated, when the transaction
 * belongs to a partner that bills on a schedule.
 *
 * Resolved once per transaction and handed to every strategy: the file
 * strategies narrow their candidates to it, the email strategies only record
 * it for now (applying it to a mailbox query is the IMAP port, yazzbert/homelab
 * item 4). A transaction with no partner, a partner with no effective cycle,
 * or a charge that belongs to none of the partner's amount bands yields
 * undefined and every strategy keeps its pre-#169 reach.
 */
async function resolveExpectedInvoiceWindow(
  transaction: Transaction
): Promise<SearchDateWindow | undefined> {
  if (!transaction.partnerId) return undefined;

  try {
    const partnerDoc = await db
      .collection(transaction.partnerType === "global" ? "globalPartners" : "partners")
      .doc(transaction.partnerId)
      .get();
    if (!partnerDoc.exists) return undefined;

    const effectiveCycles: ResolvedEffectiveCycle[] =
      (partnerDoc.data() as Partner | undefined)?.billingCycle?.effective ?? [];

    const window = expectedInvoiceWindow(
      {
        name: transaction.name,
        date: transaction.date.toDate(),
        amount: transaction.amount,
      },
      { effectiveCycles }
    );

    if (window) {
      console.log(
        `[PrecisionSearch] Billing-cycle window for tx ${transaction.id}: ` +
        `${window.from.toISOString().slice(0, 10)} .. ${window.to.toISOString().slice(0, 10)} ` +
        `(expected ${window.expectedAt.toISOString().slice(0, 10)}, +/-${window.varianceDays}d)`
      );
    }
    return window;
  } catch (error) {
    console.warn("[PrecisionSearch] Failed to resolve billing-cycle window:", error);
    return undefined;
  }
}

/** Whether a file's extracted date falls in the window. No window, or no extracted date to judge, passes. */
function isExtractedDateInWindow(
  extractedDate: Timestamp | undefined,
  dateWindow: SearchDateWindow | undefined
): boolean {
  if (!dateWindow || !extractedDate) return true;
  const dated = extractedDate.toDate().getTime();
  return dated >= dateWindow.from.getTime() && dated <= dateWindow.to.getTime();
}

/** The window as it goes into the `searchParams` audit record. */
function toWindowParams(dateWindow: SearchDateWindow) {
  return {
    expectedAt: dateWindow.expectedAt.toISOString(),
    from: dateWindow.from.toISOString(),
    to: dateWindow.to.toISOString(),
    varianceDays: dateWindow.varianceDays,
  };
}

// ============================================================================
// Strategy Execution
// ============================================================================

/**
 * Most stored Files one local-file strategy nominates a Transaction to (#589).
 * Each nomination is a full matcher run on that File, so the nearest-dated
 * candidates go first and the rest wait for the next search.
 */
const MAX_NOMINATIONS = 5;

/** Days between a File's extracted date and the Transaction; undated Files sort last. */
function daysFromTransaction(file: TaxFile, transaction: Transaction): number {
  if (!file.extractedDate) return Number.POSITIVE_INFINITY;
  return Math.abs(file.extractedDate.toMillis() - transaction.date.toMillis()) / 86_400_000;
}

/**
 * Whether the File's amount agrees with the Transaction's, by the matcher's
 * own amount comparison: within its tolerance, or through the bank-stated
 * original amount of a foreign-currency charge. Picks candidates; scores
 * nothing.
 */
function amountAgrees(file: TaxFile, transaction: Transaction): boolean {
  const payment = filePaymentTotal(file.extractedAmount, file.extractedTipAmount);
  if (payment == null) return false;
  return (
    calculateAmountScore(
      payment,
      transaction.amount,
      file.extractedCurrency,
      transaction.currency,
      readBankOriginalAmount(transaction._original?.rawRow)
    ).score > 0
  );
}

/**
 * Nominate the Transaction to each candidate File (#589): run the matcher on
 * the File with the Transaction as one more candidate, worth nothing by
 * itself. The matcher alone scores the pair and decides on a File
 * Connection, at its usual thresholds; the attempt records what it decided.
 *
 * A File still in its own matching pipeline is left to it — running the
 * matcher early would mark it matched before its Partner is known — and a
 * rejected File or a pair the File dismissed is skipped, as before.
 * `alreadyNominated` is shared by the strategies searching for one
 * Transaction.
 */
async function nominateTransaction(
  candidates: TaxFile[],
  transaction: Transaction,
  attempt: SearchAttempt,
  alreadyNominated: Set<string>
): Promise<void> {
  const nominated = (attempt.fileIdsNominated ??= []);

  for (const file of candidates) {
    if (nominated.length >= MAX_NOMINATIONS) break;

    // An earlier strategy already ran the matcher on this pair; a second run
    // would only repeat its verdict.
    if (alreadyNominated.has(file.id)) continue;

    if (isFileRejectedByTransaction(file.id, transaction)) {
      console.log(`[PrecisionSearch] Skipping rejected file ${file.fileName} (${file.id})`);
      continue;
    }
    if (isTransactionDismissed(file, transaction.id)) {
      console.log(
        `[PrecisionSearch] Skipping dismissed pair: file ${file.fileName} (${file.id}) ` +
        `x transaction ${transaction.id}`
      );
      continue;
    }
    if (file.transactionMatchComplete !== true) {
      console.log(`[PrecisionSearch] Skipping file ${file.fileName} (${file.id}): its own matching has not finished`);
      continue;
    }

    // A hint this strategy wrote before #589 scores nothing any more; drop it
    // so the File no longer claims a search vouched for the pair.
    const { id: fileId, ...fileData } = file;
    if (fileData.precisionSearchHint && isLocalFileStrategy(fileData.precisionSearchHint.searchStrategy)) {
      await db.collection("files").doc(fileId).update({ precisionSearchHint: FieldValue.delete() });
      delete fileData.precisionSearchHint;
    }

    await runTransactionMatching(fileId, fileData, { nominatedTransactionIds: [transaction.id] });
    nominated.push(fileId);
    alreadyNominated.add(fileId);

    const after = (await db.collection("files").doc(fileId).get()).data();
    const match = ((after?.transactionSuggestions ?? []) as Array<{ transactionId: string; confidence: number }>)
      .find((m) => m.transactionId === transaction.id);
    if (match) {
      attempt.matchesFound++;
      if (attempt.bestMatchScore === undefined || match.confidence > attempt.bestMatchScore) {
        attempt.bestMatchScore = match.confidence;
      }
    }
    console.log(
      `[PrecisionSearch] ${attempt.strategy}: nominated tx ${transaction.id} to file ${file.fileName} (${fileId}): ` +
      (match ? `Match at ${match.confidence}%` : "no Match")
    );

    if (((after?.transactionIds ?? []) as string[]).includes(transaction.id)) {
      // The matcher connected it, so the Transaction is documented.
      attempt.fileIdsConnected.push(fileId);
      break;
    }
  }

  attempt.candidatesEvaluated = nominated.length;
}

/**
 * Execute Strategy 1: Partner Files Matching
 * Nominate the Transaction to the Partner's unconnected Files (#589)
 */
async function executePartnerFilesStrategy(
  transaction: Transaction,
  userId: string,
  dateWindow: SearchDateWindow | undefined,
  alreadyNominated: Set<string>
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "partner_files",
    startedAt,
    searchParams: {
      partnerId: transaction.partnerId,
      ...(dateWindow ? { dateWindow: toWindowParams(dateWindow) } : {}),
    },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    fileIdsNominated: [],
  };

  try {
    // Skip if transaction has no partner
    if (!transaction.partnerId) {
      console.log(`[PrecisionSearch] partner_files: Skipped - no partnerId on transaction ${transaction.id}`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Find unassociated files for this partner
    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", transaction.partnerId)
      .where("extractionComplete", "==", true)
      .limit(50)
      .get();

    const unassociatedFiles = filesSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as TaxFile)
      .filter((f) => !f.deletedAt) // Exclude soft-deleted files
      .filter((f) => !f.transactionIds || f.transactionIds.length === 0)
      // #169: a recurring partner's charge only wants the document of its own
      // period — every other month's invoice from the same vendor carries the
      // same amount and the same name. A file with no extracted date is not
      // judged here; the matcher judges it.
      .filter((f) => isExtractedDateInWindow(f.extractedDate, dateWindow))
      .sort((a, b) => daysFromTransaction(a, transaction) - daysFromTransaction(b, transaction));

    attempt.candidatesFound = unassociatedFiles.length;
    console.log(`[PrecisionSearch] partner_files: Found ${filesSnapshot.size} files for partner, ${unassociatedFiles.length} unassociated${dateWindow ? " and inside the billing-cycle window" : ""}`);

    await nominateTransaction(unassociatedFiles, transaction, attempt, alreadyNominated);

    attempt.completedAt = Timestamp.now();
    return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : "Unknown error";
    attempt.completedAt = Timestamp.now();
    return attempt;
  }
}

/**
 * Execute Strategy 2: Amount Files Matching
 * Nominate the Transaction to unconnected Files of the same amount (#589)
 */
async function executeAmountFilesStrategy(
  transaction: Transaction,
  userId: string,
  dateWindow: SearchDateWindow | undefined,
  alreadyNominated: Set<string>
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "amount_files",
    startedAt,
    searchParams: {
      amount: transaction.amount,
      ...(dateWindow ? { dateWindow: toWindowParams(dateWindow) } : {}),
    },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    fileIdsNominated: [],
  };

  try {
    // ±90 days around the stored day. Shifted in UTC: the stored date is UTC
    // midnight of the Vienna calendar day.
    const txDate = transaction.date.toDate();
    const dateFrom = new Date(txDate.getTime() - 90 * 86_400_000);
    const dateTo = new Date(txDate.getTime() + 90 * 86_400_000);

    // #169: for a recurring partner the expected invoice date is known, so the
    // sweep narrows to that charge's own window and same-amount documents from
    // neighbouring periods never become candidates. Intersected with the ±90d
    // reach rather than replacing it, so this can only ever narrow the search:
    // a document outside ±90d was never found here before either.
    const from = dateWindow
      ? new Date(Math.max(dateFrom.getTime(), dateWindow.from.getTime()))
      : dateFrom;
    const to = dateWindow
      ? new Date(Math.min(dateTo.getTime(), dateWindow.to.getTime()))
      : dateTo;

    attempt.searchParams = {
      ...attempt.searchParams,
      dateRange: { from: from.toISOString(), to: to.toISOString() },
    };

    if (from.getTime() > to.getTime()) {
      console.log(`[PrecisionSearch] amount_files: Billing-cycle window falls outside the ±90d sweep, no candidates`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Query files in date range
    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("extractionComplete", "==", true)
      .where("extractedDate", ">=", Timestamp.fromDate(from))
      .where("extractedDate", "<=", Timestamp.fromDate(to))
      .limit(100)
      .get();

    // Unassociated, non-deleted files whose amount agrees, nearest-dated first
    const candidates = filesSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as TaxFile)
      .filter((f) => !f.deletedAt) // Exclude soft-deleted files
      .filter((f) => !f.transactionIds || f.transactionIds.length === 0)
      .filter((f) => amountAgrees(f, transaction))
      .sort((a, b) => daysFromTransaction(a, transaction) - daysFromTransaction(b, transaction));

    attempt.candidatesFound = candidates.length;
    console.log(`[PrecisionSearch] amount_files: Query returned ${filesSnapshot.size} files in date range, ${candidates.length} unassociated with an agreeing amount`);

    await nominateTransaction(candidates, transaction, attempt, alreadyNominated);

    attempt.completedAt = Timestamp.now();
    return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : "Unknown error";
    attempt.completedAt = Timestamp.now();
    return attempt;
  }
}

/**
 * Execute Strategy 3: Email Attachment Search
 * Search every Mail Integration the receipt search reads, Gmail and IMAP alike
 * (#746), for attachments that could match, using Gemini-generated queries.
 */
async function executeEmailAttachmentStrategy(
  transaction: Transaction,
  userId: string,
  // #169: carried, not yet applied. The mail window below is the fixed
  // ±180 days the strategy has always kept; narrowing it to this window is
  // its own decision.
  dateWindow: SearchDateWindow | undefined,
  openMailboxes: () => Promise<SearchedMailbox[]>
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "email_attachment",
    startedAt,
    searchParams: {
      transactionName: transaction.name,
      ...(dateWindow ? { dateWindow: toWindowParams(dateWindow) } : {}),
    },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    geminiCalls: 0,
    geminiTokensUsed: 0,
  };

  try {
    const mailboxes = (await openMailboxes()).filter(isUsable);
    if (mailboxes.length === 0) {
      console.log(`[PrecisionSearch] email_attachment: No searchable Mail Integration for user`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }
    console.log(`[PrecisionSearch] email_attachment: Searching ${mailboxes.length} Mail Integration(s)`);

    // Get partner info if available
    let partnerInfo: QueryGenerationPartner | undefined;
    if (transaction.partnerId) {
      const partnerDoc = await db
        .collection(transaction.partnerType === "global" ? "globalPartners" : "partners")
        .doc(transaction.partnerId)
        .get();
      if (partnerDoc.exists) {
        const data = partnerDoc.data()!;
        partnerInfo = {
          name: data.name,
          emailDomains: data.emailDomains,
          website: data.website,
          ibans: data.ibans,
          vatId: data.vatId,
          aliases: data.aliases,
          fileSourcePatterns: data.fileSourcePatterns,
        };
      }
    }

    // Generate search suggestions using Gemini (same as UI); each carries its
    // provider-neutral terms (#240), which is what a mailbox is searched by.
    const suggestions = (
      await generateTypedQueriesWithGemini(
        {
          name: transaction.name,
          partner: transaction.partner,
          description: transaction.description,
          reference: transaction.reference,
          amount: transaction.amount,
        },
        partnerInfo,
        8,
        userId
      )
    ).slice(0, 3);
    const queries = suggestions.map((s) => s.query);
    console.log(`[PrecisionSearch] email_attachment: Using ${queries.length} Gemini queries for tx "${transaction.name}":`, queries);

    if (queries.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    attempt.searchParams = {
      ...attempt.searchParams,
      queries,
    };

    const processedMessageIds = new Set<string>();
    const txDate = transaction.date.toDate();
    const { dateFrom, dateTo } = mailWindow(txDate);
    let greatMatchCount = 0; // Stop trying more queries after GREAT_MATCH_COUNT matches at GREAT_MATCH_THRESHOLD%

    for (const mailbox of mailboxes) {
      if (greatMatchCount >= GREAT_MATCH_COUNT) break;
      for (const suggestion of suggestions) {
        if (greatMatchCount >= GREAT_MATCH_COUNT || !isUsable(mailbox)) break;
        const terms = namedSearchTerms(suggestion.terms);
        if (!terms) continue;

        let messageRefs: Array<{ id: string }>;
        try {
          const page = await mailbox.mail.search({ ...terms, hasAttachment: true, dateFrom, dateTo, limit: 20 });
          mailbox.searched = true;
          noteLimitations(attempt, mailbox, page.limitations);
          messageRefs = page.messages;
        } catch (searchError) {
          console.error(`[PrecisionSearch] Error searching ${mailbox.id} with query "${suggestion.query}":`, searchError);
          await failMailbox(db, mailbox, searchError);
          continue;
        }
        console.log(`[PrecisionSearch] email_attachment: Query "${suggestion.query.substring(0, 50)}..." returned ${messageRefs.length} messages in ${mailbox.id}`);
        attempt.candidatesFound += messageRefs.length;

        for (const { id: messageId } of messageRefs) {
          if (!isUsable(mailbox)) break;
          // Skip already processed messages; an IMAP UID is unique only within its mailbox
          const seenKey = `${mailbox.id}:${messageId}`;
          if (processedMessageIds.has(seenKey)) continue;
          processedMessageIds.add(seenKey);

          attempt.candidatesEvaluated++;

          try {
            const message = await fromMailbox(mailbox.mail.getMessage({ id: messageId }));

            // Verify email date is within range (the search window is the same; a provider may round it to the day)
            const emailDate = message.date;
            if (!isEmailDateInRange(emailDate, txDate, MAIL_WINDOW_DAYS)) {
              console.log(`[PrecisionSearch] Skipping message - date ${emailDate.toISOString().split("T")[0]} outside ±180 days of tx`);
              continue;
            }

            const allAttachments = receiptAttachments(message);

            // Classify email BEFORE processing attachments
            const subject = message.subject;
            const classification = classifyEmail(subject, message.snippet || "", allAttachments);

            console.log(`[PrecisionSearch] Email classification for ${messageId}: ` +
              `hasPdf=${classification.hasPdfAttachment}, mailInvoice=${classification.possibleMailInvoice}, ` +
              `invoiceLink=${classification.possibleInvoiceLink}, confidence=${classification.confidence}%` +
              (classification.matchedKeywords.length > 0 ? ` [${classification.matchedKeywords.join(", ")}]` : ""));

            // Skip if this is a mail-invoice-only (no PDF) - let email_invoice strategy handle it
            if (classification.possibleMailInvoice && !classification.hasPdfAttachment) {
              console.log(`[PrecisionSearch] Skipping ${messageId} - mail invoice without PDF attachment (handled by email_invoice strategy)`);
              continue;
            }

            // Log all attachments for debugging
            console.log(`[PrecisionSearch] Message ${messageId} has ${allAttachments.length} attachment(s):`,
              allAttachments.map(a => `${a.filename} (${a.mimeType}, isLikelyReceipt=${a.isLikelyReceipt})`));

            // Filter to likely receipts (PDFs) for processing
            const attachments = allAttachments.filter(a => a.isLikelyReceipt);

            if (attachments.length === 0) {
              console.log(`[PrecisionSearch] No likely receipt attachments in message ${messageId}`);
              continue;
            }

            // Sort: PDFs first, then images (prioritize PDFs as they're usually better quality)
            const sortedAttachments = [...attachments].sort((a, b) => {
              const aIsPdf = a.mimeType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf");
              const bIsPdf = b.mimeType === "application/pdf" || b.filename.toLowerCase().endsWith(".pdf");
              if (aIsPdf && !bIsPdf) return -1;
              if (!aIsPdf && bIsPdf) return 1;
              return 0;
            });

            let foundPdfMatch = false;

            // Process each attachment (PDFs first)
            for (const attachment of sortedAttachments) {
              // Skip images if we already found a PDF match in this message
              const isPdf = attachment.mimeType === "application/pdf" || attachment.filename.toLowerCase().endsWith(".pdf");
              if (foundPdfMatch && !isPdf) {
                console.log(`[PrecisionSearch] Skipping image ${attachment.filename} - PDF already matched in this message`);
                continue;
              }
              // Check if we already have this attachment
              const existingFiles = await filesFromMailPart(userId, mailbox, messageId, {
                attachmentId: attachment.attachmentId,
              });

              if (existingFiles.length > 0) {
                // File already exists - score it and potentially connect to transaction
                const existingDoc = existingFiles[0];
                const existingFile = { id: existingDoc.id, ...existingDoc.data() } as TaxFile;
                const fileName = existingFile.fileName || attachment.filename;

                // Skip if already connected to this transaction
                if (existingFile.transactionIds?.includes(transaction.id)) {
                  console.log(`[PrecisionSearch] File already connected: ${fileName}`);
                  continue;
                }

                // Score the existing file using unified scoring (same as UI)
                // Include email metadata for better scoring
                const scoreInput: ScoreAttachmentInput = {
                  filename: fileName,
                  mimeType: attachment.mimeType,
                  emailSubject: message.subject,
                  emailFrom: message.from,
                  emailBodyText: existingFile.extractedText,
                  emailDate,
                  integrationId: mailbox.id,
                  transactionAmount: transaction.amount,
                  transactionOriginalAmount: originalAmountOf(transaction),
                  transactionDate: transaction.date.toDate(),
                  transactionName: transaction.name,
                  transactionReference: transaction.reference,
                  transactionPartner: transaction.partner,
                  partnerName: partnerInfo?.name,
                  partnerEmailDomains: partnerInfo?.emailDomains,
                };
                const score = scoreAttachmentMatch(scoreInput);
                console.log(
                  `[PrecisionSearch] Match score for file ${fileName} (${existingFile.id}): ${score.score}% ` +
                  `[${score.reasons.slice(0, 3).join(", ")}]`
                );

                // If score meets threshold, add hint to trigger re-matching
                if (score.score >= ATTACHMENT_MATCH_THRESHOLD) {
                  // Check if this file was rejected by the transaction
                  if (isFileRejectedByTransaction(existingFile.id, transaction)) {
                    console.log(`[PrecisionSearch] Skipping rejected file ${fileName} (${existingFile.id})`);
                    continue;
                  }
                  // ...or dismissed on the file's side
                  if (isTransactionDismissed(existingFile, transaction.id)) {
                    console.log(
                      `[PrecisionSearch] Skipping dismissed pair: file ${fileName} ` +
                      `(${existingFile.id}) x transaction ${transaction.id}`
                    );
                    continue;
                  }
                  await db.collection("files").doc(existingFile.id).update({
                    precisionSearchHint: {
                      transactionId: transaction.id,
                      transactionAmount: transaction.amount,
                      transactionDate: transaction.date,
                      searchStrategy: "email_attachment",
                      matchConfidence: score.score,
                      searchedAt: Timestamp.now(),
                    },
                    transactionMatchComplete: false, // Re-trigger matching
                    updatedAt: Timestamp.now(),
                  });
                  attempt.fileIdsConnected.push(existingFile.id);
                  attempt.matchesFound++;
                  if (isPdf) foundPdfMatch = true;
                  console.log(`[PrecisionSearch] Existing file ${fileName} matched at ${score.score}%`);

                  // Stop trying more queries if this is a great match
                  if (score.score >= GREAT_MATCH_THRESHOLD) {
                    greatMatchCount++;
                    console.log(`[PrecisionSearch] Great match found (${score.score}%), count: ${greatMatchCount}/${GREAT_MATCH_COUNT}`);
                  }
                } else {
                  console.log(`[PrecisionSearch] Existing file ${fileName} scored ${score.score}% (below ${ATTACHMENT_MATCH_THRESHOLD}% threshold)`);
                }
                continue;
              }

              // Download and create new file (with hint for matching)
              const attachmentData = await fromMailbox(mailbox.mail.getAttachment(message, attachment));
              const result = await createFileFromAttachment(
                userId,
                attachmentData,
                attachment,
                message,
                mailbox.id,
                mailbox.email,
                {
                  transactionId: transaction.id,
                  transactionAmount: transaction.amount,
                  transactionDate: transaction.date,
                  searchStrategy: "email_attachment",
                  searchedAt: Timestamp.now(),
                }
              );

              if (result) {
                // Check if this is an existing file (found by hash)
                if (result.startsWith("existing:")) {
                  const existingFileId = result.substring(9);
                  const existingDoc = await db.collection("files").doc(existingFileId).get();
                  if (existingDoc.exists) {
                    const existingFile = { id: existingDoc.id, ...existingDoc.data() } as TaxFile;
                    const fileName = existingFile.fileName || attachment.filename;

                    // Skip if already connected to this transaction
                    if (existingFile.transactionIds?.includes(transaction.id)) {
                      console.log(`[PrecisionSearch] File already connected: ${fileName}`);
                      continue;
                    }

                    // Score the existing file using unified scoring
                    const scoreInput: ScoreAttachmentInput = {
                      filename: fileName,
                      mimeType: attachment.mimeType,
                      emailSubject: message.subject,
                      emailFrom: message.from,
                      emailBodyText: existingFile.extractedText,
                      emailDate,
                      integrationId: mailbox.id,
                      transactionAmount: transaction.amount,
                      transactionOriginalAmount: originalAmountOf(transaction),
                      transactionDate: transaction.date.toDate(),
                      transactionName: transaction.name,
                      transactionReference: transaction.reference,
                      transactionPartner: transaction.partner,
                      partnerName: partnerInfo?.name,
                      partnerEmailDomains: partnerInfo?.emailDomains,
                    };
                    const score = scoreAttachmentMatch(scoreInput);
                    console.log(
                      `[PrecisionSearch] Match score for file ${fileName} (${existingFileId}): ${score.score}% ` +
                      `[${score.reasons.slice(0, 3).join(", ")}]`
                    );

                    if (score.score >= ATTACHMENT_MATCH_THRESHOLD) {
                      // Check if this file was rejected by the transaction
                      if (isFileRejectedByTransaction(existingFileId, transaction)) {
                        console.log(`[PrecisionSearch] Skipping rejected file ${fileName} (${existingFileId})`);
                      } else if (isTransactionDismissed(existingFile, transaction.id)) {
                        console.log(
                          `[PrecisionSearch] Skipping dismissed pair: file ${fileName} ` +
                          `(${existingFileId}) x transaction ${transaction.id}`
                        );
                      } else {
                        await db.collection("files").doc(existingFileId).update({
                          precisionSearchHint: {
                            transactionId: transaction.id,
                            transactionAmount: transaction.amount,
                            transactionDate: transaction.date,
                            searchStrategy: "email_attachment",
                            matchConfidence: score.score,
                            searchedAt: Timestamp.now(),
                          },
                          transactionMatchComplete: false,
                          updatedAt: Timestamp.now(),
                        });
                        attempt.fileIdsConnected.push(existingFileId);
                        attempt.matchesFound++;
                        if (isPdf) foundPdfMatch = true;
                        console.log(`[PrecisionSearch] Existing file ${fileName} matched at ${score.score}%`);

                        // Stop trying more queries if this is a great match
                        if (score.score >= GREAT_MATCH_THRESHOLD) {
                          greatMatchCount++;
                          console.log(`[PrecisionSearch] Great match found (${score.score}%), count: ${greatMatchCount}/${GREAT_MATCH_COUNT}`);
                        }
                      }
                    } else {
                      console.log(`[PrecisionSearch] Existing file ${fileName} scored ${score.score}% (below threshold)`);
                    }
                  }
                } else {
                  // New file created - matchFileTransactions will handle connection after extraction
                  attempt.fileIdsConnected.push(result);
                  attempt.matchesFound++;
                  mailbox.filesCreated++;
                  if (isPdf) foundPdfMatch = true;
                }
              }
            }
          } catch (msgError) {
            console.error(`[PrecisionSearch] Error processing message ${messageId} in ${mailbox.id}:`, msgError);
            // Only a failure reading the mailbox is the mailbox's; a storage or
            // AI failure is logged with the message and the search moves on.
            if (msgError instanceof MailboxReadError) await failMailbox(db, mailbox, msgError.cause);
          }
        }
      }
    }

    attempt.completedAt = Timestamp.now();
    return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : "Unknown error";
    attempt.completedAt = Timestamp.now();
    return attempt;
  }
}

/**
 * Execute Strategy 4: Email Invoice Parsing
 * Parse email content for invoice links or HTML invoices, in every Mail
 * Integration whose Mail Provider can read a message body (#746).
 */
async function executeEmailInvoiceStrategy(
  transaction: Transaction,
  userId: string,
  // #169: carried, not yet applied — see `executeEmailAttachmentStrategy`.
  dateWindow: SearchDateWindow | undefined,
  openMailboxes: () => Promise<SearchedMailbox[]>
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "email_invoice",
    startedAt,
    searchParams: {
      transactionName: transaction.name,
      partnerId: transaction.partnerId,
      ...(dateWindow ? { dateWindow: toWindowParams(dateWindow) } : {}),
    },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    invoiceLinksFound: [],
    geminiCalls: 0,
    geminiTokensUsed: 0,
  };

  try {
    const mailboxes = (await openMailboxes()).filter((m) => isUsable(m) && typeof m.mail.getBody === "function");
    if (mailboxes.length === 0) {
      console.log(`[PrecisionSearch] email_invoice: No searchable Mail Integration for user`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }
    console.log(`[PrecisionSearch] email_invoice: Searching ${mailboxes.length} Mail Integration(s)`);

    // Get partner info if available
    let partnerInfo: Partner | undefined;
    let partnerId = transaction.partnerId;
    let partnerType = transaction.partnerType;

    if (partnerId) {
      const partnerDoc = await db
        .collection(partnerType === "global" ? "globalPartners" : "partners")
        .doc(partnerId)
        .get();
      if (partnerDoc.exists) {
        partnerInfo = partnerDoc.data() as Partner;
      }
    }

    // Generate search suggestions using Gemini (same as UI)
    const suggestions = (
      await generateTypedQueriesWithGemini(
        {
          name: transaction.name,
          partner: transaction.partner,
          description: transaction.description,
          reference: transaction.reference,
          amount: transaction.amount,
        },
        partnerInfo ? {
          name: partnerInfo.name,
          emailDomains: partnerInfo.emailDomains,
          website: partnerInfo.website,
          ibans: partnerInfo.ibans,
          vatId: partnerInfo.vatId,
          aliases: partnerInfo.aliases,
          fileSourcePatterns: partnerInfo.fileSourcePatterns,
        } : undefined,
        8,
        userId
      )
    ).slice(0, 3); // First 3 (same as clicking suggestions in UI)
    const queries = suggestions.map((s) => s.query);
    console.log(`[PrecisionSearch] email_invoice: Using ${queries.length} queries for tx "${transaction.name}":`, queries);

    if (queries.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    attempt.searchParams = {
      ...attempt.searchParams,
      queries,
    };

    // Search each mailbox with each query, without the attachment requirement
    const processedMessageIds = new Set<string>();
    const txDate = transaction.date.toDate();
    const { dateFrom, dateTo } = mailWindow(txDate);
    let greatMatchCount = 0; // Stop trying more queries after GREAT_MATCH_COUNT matches at GREAT_MATCH_THRESHOLD%

    for (const mailbox of mailboxes) {
      if (greatMatchCount >= GREAT_MATCH_COUNT) break;
      for (const suggestion of suggestions) {
        if (greatMatchCount >= GREAT_MATCH_COUNT || !isUsable(mailbox)) break;
        const terms = namedSearchTerms(suggestion.terms);
        if (!terms) continue;

        let messageRefs: Array<{ id: string }>;
        try {
          const page = await mailbox.mail.search({ ...terms, hasAttachment: false, dateFrom, dateTo, limit: 20 });
          mailbox.searched = true;
          noteLimitations(attempt, mailbox, page.limitations);
          messageRefs = page.messages;
        } catch (searchError) {
          console.error(`[PrecisionSearch] Error searching ${mailbox.id} with query "${suggestion.query}":`, searchError);
          await failMailbox(db, mailbox, searchError);
          continue;
        }
        console.log(`[PrecisionSearch] email_invoice: Query "${suggestion.query.substring(0, 50)}..." returned ${messageRefs.length} messages in ${mailbox.id}`);
        attempt.candidatesFound += messageRefs.length;

        for (const { id: messageId } of messageRefs) {
          if (!isUsable(mailbox)) break;
          const seenKey = `${mailbox.id}:${messageId}`;
          if (processedMessageIds.has(seenKey)) continue;
          processedMessageIds.add(seenKey);

          attempt.candidatesEvaluated++;

          try {
            const message = await fromMailbox(mailbox.mail.getMessage({ id: messageId }));
            const from = message.from;
            const subject = message.subject;

            // Pre-classify email to prioritize likely mail invoices
            const allAttachments = receiptAttachments(message);
            const classification = classifyEmail(subject, message.snippet || "", allAttachments);

            console.log(`[PrecisionSearch] email_invoice: Classification for ${messageId}: ` +
              `hasPdf=${classification.hasPdfAttachment}, mailInvoice=${classification.possibleMailInvoice}, ` +
              `invoiceLink=${classification.possibleInvoiceLink}, confidence=${classification.confidence}%`);

            // Skip if has PDF attachment - email_attachment strategy handles those
            if (classification.hasPdfAttachment) {
              console.log(`[PrecisionSearch] Skipping ${messageId} - has PDF attachment (handled by email_attachment strategy)`);
              continue;
            }

            // Check email date is within range
            const emailDate = message.date;
            if (!isEmailDateInRange(emailDate, txDate, MAIL_WINDOW_DAYS)) {
              console.log(`[PrecisionSearch] Skipping message - date ${emailDate.toISOString().split("T")[0]} outside ±180 days of tx`);
              continue;
            }

            const body = await fromMailbox(mailbox.mail.getBody!({ id: messageId }));
            const html = body.html ?? undefined;
            const text = body.text ?? undefined;

            // Analyze email content with Gemini
            const analysis = await analyzeEmailForInvoice(
              { subject, from, htmlBody: html, textBody: text },
              {
                name: transaction.name,
                partner: transaction.partner,
                amount: transaction.amount,
              },
              userId
            );

            attempt.geminiCalls = (attempt.geminiCalls || 0) + 1;
            attempt.geminiTokensUsed =
              (attempt.geminiTokensUsed || 0) + analysis.usage.inputTokens + analysis.usage.outputTokens;

            // Handle invoice links - store on partner
            if (analysis.hasInvoiceLink && analysis.invoiceLinks.length > 0 && partnerId) {
              const now = Timestamp.now();
              for (const link of analysis.invoiceLinks) {
                attempt.invoiceLinksFound?.push(link.url);

                // Add invoice link to partner
                await db
                  .collection(partnerType === "global" ? "globalPartners" : "partners")
                  .doc(partnerId)
                  .update({
                    invoiceLinks: FieldValue.arrayUnion({
                      url: link.url,
                      anchorText: link.anchorText,
                      emailMessageId: messageId,
                      emailSubject: subject,
                      discoveredAt: now,
                    }),
                    invoiceLinksUpdatedAt: now,
                    updatedAt: now,
                  });
              }

              console.log(
                `[PrecisionSearch] Found ${analysis.invoiceLinks.length} invoice links for partner ${partnerId}`
              );
            }

            // Handle mail invoice (email itself is the invoice)
            if (analysis.isMailInvoice && analysis.mailInvoiceConfidence >= 0.7 && html) {
              // Score the email using unified scoring (same as UI)
              // Use the provider's snippet where it has one, with body text as fallback
              const bodyText = text || (html ? html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : undefined);
              const emailScoreInput: ScoreAttachmentInput = {
                filename: `${subject}.pdf`,
                mimeType: "application/pdf",
                emailSubject: subject,
                emailFrom: from,
                emailSnippet: message.snippet || bodyText?.substring(0, 500),
                emailBodyText: bodyText,
                emailDate,
                integrationId: mailbox.id,
                transactionAmount: transaction.amount,
                transactionOriginalAmount: originalAmountOf(transaction),
                transactionDate: txDate,
                transactionName: transaction.name,
                transactionReference: transaction.reference,
                // Use name as fallback when partner is not assigned
                transactionPartner: transaction.partner || transaction.name,
                partnerName: partnerInfo?.name,
                partnerEmailDomains: partnerInfo?.emailDomains,
              };
              const emailScore = scoreAttachmentMatch(emailScoreInput);
              console.log(
                `[PrecisionSearch] Email invoice score for "${subject.substring(0, 40)}...": ${emailScore.score}% ` +
                `[${emailScore.reasons.join(", ")}]`
              );

              // Track best score
              if (!attempt.bestMatchScore || emailScore.score > attempt.bestMatchScore) {
                attempt.bestMatchScore = emailScore.score;
              }

              // Only convert if score meets threshold
              if (emailScore.score < ATTACHMENT_MATCH_THRESHOLD) {
                console.log(`[PrecisionSearch] Email invoice scored ${emailScore.score}% (below ${ATTACHMENT_MATCH_THRESHOLD}% threshold), skipping`);
                continue;
              }

              // Check if we already converted this email
              const existingFiles = await filesFromMailPart(userId, mailbox, messageId, {
                sourceType: "gmail_html_invoice",
              });

              if (existingFiles.length === 0) {
                // Convert HTML to PDF
                const pdfResult = await convertHtmlToPdf(html, {
                  subject,
                  from,
                  date: emailDate,
                });

                // Create filename from subject
                const sanitizedSubject = subject
                  .replace(/[^a-zA-Z0-9\s]/g, "")
                  .trim()
                  .substring(0, 50);
                const filename = `${sanitizedSubject || "invoice"}_${emailDate.toISOString().split("T")[0]}.pdf`;

                const fileId = await createFileFromHtmlPdf(
                  userId,
                  pdfResult.pdfBuffer,
                  filename,
                  message,
                  mailbox.id,
                  mailbox.email,
                  {
                    transactionId: transaction.id,
                    transactionAmount: transaction.amount,
                    transactionDate: transaction.date,
                    searchStrategy: "email_invoice",
                    searchedAt: Timestamp.now(),
                  }
                );

                if (fileId) {
                  // File created - matchFileTransactions will handle connection after extraction
                  attempt.fileIdsConnected.push(fileId);
                  attempt.matchesFound++;
                  if (!fileId.startsWith("existing:")) mailbox.filesCreated++;
                  console.log(`[PrecisionSearch] Created PDF from mail invoice: ${filename} (score: ${emailScore.score}%)`);

                  // Stop trying more queries if this is a great match
                  if (emailScore.score >= GREAT_MATCH_THRESHOLD) {
                    greatMatchCount++;
                    console.log(`[PrecisionSearch] Great match found (${emailScore.score}%), count: ${greatMatchCount}/${GREAT_MATCH_COUNT}`);
                  }
                }
              }
            }
          } catch (msgError) {
            console.error(`[PrecisionSearch] Error processing message ${messageId} in ${mailbox.id}:`, msgError);
            // Only a failure reading the mailbox is the mailbox's; a storage or
            // AI failure is logged with the message and the search moves on.
            if (msgError instanceof MailboxReadError) await failMailbox(db, mailbox, msgError.cause);
          }
        }
      }
    }

    attempt.completedAt = Timestamp.now();
    return attempt;
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : "Unknown error";
    attempt.completedAt = Timestamp.now();
    return attempt;
  }
}

/**
 * Execute a single strategy for a transaction
 */
async function executeStrategy(
  strategy: SearchStrategy,
  transaction: Transaction,
  userId: string,
  dateWindow: SearchDateWindow | undefined,
  nominatedFileIds: Set<string>,
  openMailboxes: () => Promise<SearchedMailbox[]>
): Promise<SearchAttempt> {
  switch (strategy) {
    case "partner_files":
      return executePartnerFilesStrategy(transaction, userId, dateWindow, nominatedFileIds);
    case "amount_files":
      return executeAmountFilesStrategy(transaction, userId, dateWindow, nominatedFileIds);
    case "email_attachment":
      return executeEmailAttachmentStrategy(transaction, userId, dateWindow, openMailboxes);
    case "email_invoice":
      return executeEmailInvoiceStrategy(transaction, userId, dateWindow, openMailboxes);
    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }
}

/**
 * Create or update transaction search entry
 */
async function logSearchAttempt(
  transactionId: string,
  queueId: string,
  triggeredBy: string,
  attempt: SearchAttempt
): Promise<void> {
  const searchesRef = db
    .collection("transactions")
    .doc(transactionId)
    .collection("searches");

  // Check if there's an existing search entry for this queue
  const existingSearch = await searchesRef
    .where("precisionSearchQueueId", "==", queueId)
    .limit(1)
    .get();

  if (existingSearch.empty) {
    // Create new search entry
    await searchesRef.add({
      triggeredBy,
      precisionSearchQueueId: queueId,
      status: "processing",
      strategiesAttempted: [attempt.strategy],
      attempts: [attempt],
      totalFilesConnected: attempt.fileIdsConnected.length,
      automationSource: attempt.fileIdsConnected.length > 0 ? attempt.strategy : null,
      totalGeminiCalls: attempt.geminiCalls || 0,
      totalGeminiTokens: attempt.geminiTokensUsed || 0,
      createdAt: Timestamp.now(),
      startedAt: attempt.startedAt,
    });
  } else {
    // Update existing search entry
    const searchDoc = existingSearch.docs[0];
    const data = searchDoc.data();
    const existingAttempts = data.attempts || [];
    const existingStrategies = data.strategiesAttempted || [];

    await searchDoc.ref.update({
      strategiesAttempted: existingStrategies.includes(attempt.strategy)
        ? existingStrategies
        : [...existingStrategies, attempt.strategy],
      attempts: [...existingAttempts, attempt],
      totalFilesConnected: (data.totalFilesConnected || 0) + attempt.fileIdsConnected.length,
      automationSource:
        attempt.fileIdsConnected.length > 0
          ? attempt.strategy
          : data.automationSource,
      totalGeminiCalls: (data.totalGeminiCalls || 0) + (attempt.geminiCalls || 0),
      totalGeminiTokens: (data.totalGeminiTokens || 0) + (attempt.geminiTokensUsed || 0),
    });
  }
}

// ============================================================================
// Queue Processor
// ============================================================================

/**
 * Run one queue item with the User's mailboxes opened at most once for it
 * (#746): every Transaction and both email strategies share the connections,
 * so an Import of fifty lines costs one IMAP login per mailbox, not a burst of
 * one per line. Closed, and the search recorded on each mailbox, at the end.
 */
async function processQueueItem(queueItem: PrecisionSearchQueueItem): Promise<{
  paused?: boolean;
  pauseReason?: string;
}> {
  let opened: Promise<SearchedMailbox[]> | null = null;
  const openMailboxes = () => (opened ??= openSearchedMailboxes(db, queueItem.userId));
  try {
    return await runQueueItem(queueItem, openMailboxes);
  } finally {
    if (opened) {
      try {
        await closeSearchedMailboxes(db, await opened);
      } catch (error) {
        console.error(`[PrecisionSearch] Recording the search on the mailboxes failed:`, error);
      }
    }
  }
}

async function runQueueItem(
  queueItem: PrecisionSearchQueueItem,
  openMailboxes: () => Promise<SearchedMailbox[]>
): Promise<{
  paused?: boolean;
  pauseReason?: string;
}> {
  const startTime = Date.now();
  console.log(
    `[PrecisionSearch] Processing queue ${queueItem.id} (${queueItem.scope}, ${queueItem.triggeredBy})`
  );

  // A mailbox needs new credentials - pause rather than search without it
  const mailStatus = await shouldPauseForMailReauth(queueItem.userId);
  if (mailStatus.shouldPause) {
    console.log(
      `[PrecisionSearch] Pausing queue ${queueItem.id}: ${mailStatus.reason} (${mailStatus.integrationEmail})`
    );
    // Revert to pending so it will be picked up again after the mailbox is reconnected
    await db.collection("precisionSearchQueue").doc(queueItem.id).update({
      status: "pending",
      startedAt: null,
      lastError: `Paused: ${mailStatus.reason}. Will resume when the mailbox is reconnected.`,
    });
    return { paused: true, pauseReason: mailStatus.reason };
  }

  // No mailbox the search reads - skip the email strategies entirely,
  // which also saves the Gemini calls that would generate their queries
  const hasEmailIntegration = await hasSearchableMailIntegration(queueItem.userId);
  if (!hasEmailIntegration) {
    const originalStrategies = queueItem.strategies;
    queueItem.strategies = queueItem.strategies.filter(
      (s) => !["email_attachment", "email_invoice"].includes(s)
    );
    if (queueItem.strategies.length !== originalStrategies.length) {
      console.log(
        `[PrecisionSearch] No active email integration - filtering strategies from [${originalStrategies.join(", ")}] to [${queueItem.strategies.join(", ")}]`
      );
    }
  }

  let transactionsProcessed = queueItem.transactionsProcessed;
  let transactionsWithMatches = queueItem.transactionsWithMatches;
  let totalFilesConnected = queueItem.totalFilesConnected;
  const errors: string[] = [...queueItem.errors];
  let lastProcessedTransactionId = queueItem.lastProcessedTransactionId;
  let timedOut = false;

  try {
    // Get transactions to process
    let transactionsQuery;

    if (queueItem.scope === "single_transaction" && queueItem.transactionId) {
      // Single transaction
      const txDoc = await db
        .collection("transactions")
        .doc(queueItem.transactionId)
        .get();

      if (!txDoc.exists || txDoc.data()?.userId !== queueItem.userId) {
        throw new Error("Transaction not found or access denied");
      }

      const transactions = [{ id: txDoc.id, ...txDoc.data() } as Transaction];
      await processTransactionBatch(transactions);
    } else {
      // All incomplete transactions
      transactionsQuery = db
        .collection("transactions")
        .where("userId", "==", queueItem.userId)
        .where("isComplete", "==", false)
        .orderBy("date", "desc")
        .limit(TRANSACTIONS_PER_BATCH);

      if (lastProcessedTransactionId) {
        // Cursor-based pagination - get document and start after
        const lastDoc = await db
          .collection("transactions")
          .doc(lastProcessedTransactionId)
          .get();
        if (lastDoc.exists) {
          transactionsQuery = transactionsQuery.startAfter(lastDoc);
        }
      }

      const snapshot = await transactionsQuery.get();
      const transactions = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as Transaction
      );

      if (transactions.length === 0) {
        // No more transactions to process
        await completeQueueItem();
        return {};
      }

      await processTransactionBatch(transactions);
    }

    // Check if we need to continue or are done
    if (queueItem.scope === "single_transaction" || timedOut) {
      if (timedOut) {
        await createContinuation();
      } else {
        await completeQueueItem();
      }
    } else {
      // Check if there are more transactions
      const remainingCount = queueItem.transactionsToProcess - transactionsProcessed;
      if (remainingCount > 0 && lastProcessedTransactionId) {
        // More to process - create continuation
        await createContinuation();
      } else {
        await completeQueueItem();
      }
    }
  } catch (error) {
    console.error(`[PrecisionSearch] Error processing queue:`, error);
    await handleError(error);
  }

  return {};

  // ========== Helper functions ==========

  async function processTransactionBatch(transactions: Transaction[]): Promise<void> {
    for (const tx of transactions) {
      // Check timeout
      if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
        console.log("[PrecisionSearch] Approaching timeout, saving progress");
        timedOut = true;
        break;
      }

      // Re-fetch transaction to check if it was completed while we were processing
      // This handles the case where user manually connects a file during batch processing
      const freshTxDoc = await db.collection("transactions").doc(tx.id).get();
      if (!freshTxDoc.exists) {
        console.log(`[PrecisionSearch] Transaction ${tx.id} no longer exists, skipping`);
        transactionsProcessed++;
        lastProcessedTransactionId = tx.id;
        continue;
      }
      const freshTx = freshTxDoc.data();
      if (freshTx?.isComplete) {
        console.log(`[PrecisionSearch] Transaction ${tx.id} already complete (resolved during processing), skipping`);
        transactionsProcessed++;
        lastProcessedTransactionId = tx.id;
        continue;
      }

      try {
        let foundMatch = false;

        // #169: resolved once for the transaction, not once per strategy —
        // every strategy scores the same charge, so they must agree on when
        // its document is expected.
        const dateWindow = await resolveExpectedInvoiceWindow(tx);

        // Run strategies in order until one finds a match
        // Threshold for stopping early - only stop if we find a very strong match
        // Set high because attachment scoring and transaction scoring can diverge
        const STRONG_MATCH_THRESHOLD = 85;

        // Stored Files this transaction was nominated to (#589), shared by
        // the local-file strategies so no File is matched twice for it.
        const nominatedFileIds = new Set<string>();

        for (const strategy of queueItem.strategies) {
          // Skip if transaction already completed (from initial data)
          if (tx.isComplete) break;

          const attempt = await executeStrategy(strategy, tx, queueItem.userId, dateWindow, nominatedFileIds, openMailboxes);

          // Log the attempt
          await logSearchAttempt(tx.id, queueItem.id, queueItem.triggeredBy, attempt);

          if (attempt.fileIdsConnected.length > 0) {
            foundMatch = true;
            totalFilesConnected += attempt.fileIdsConnected.length;

            // Only stop early if we found a strong match (60%+)
            // Otherwise continue to try other strategies which might find better matches
            if (attempt.bestMatchScore && attempt.bestMatchScore >= STRONG_MATCH_THRESHOLD) {
              console.log(`[PrecisionSearch] Strong match found (${attempt.bestMatchScore}%), stopping search`);
              break;
            } else {
              console.log(`[PrecisionSearch] Weak match found (${attempt.bestMatchScore}%), continuing to try other strategies`);
            }
          }

          if (attempt.error) {
            errors.push(`${tx.id}/${strategy}: ${attempt.error}`);
          }
        }

        if (foundMatch) {
          transactionsWithMatches++;
        }

        transactionsProcessed++;
        lastProcessedTransactionId = tx.id;

        // Small delay between transactions to avoid overwhelming Firestore
        await sleep(50);
      } catch (txError) {
        const errorMsg = `Failed to process tx ${tx.id}: ${txError}`;
        console.error(`[PrecisionSearch] ${errorMsg}`);
        errors.push(errorMsg);
        transactionsProcessed++;
        lastProcessedTransactionId = tx.id;
      }
    }
  }

  async function createContinuation(): Promise<void> {
    // For manual/gmail_sync, create new queue item (triggers immediate processing)
    // For scheduled, just update and let cron handle it
    if (queueItem.triggeredBy === "scheduled") {
      // lastProcessedTransactionId is spread conditionally for the same reason as
      // in the continuation below: it is still undefined when the budget runs out
      // before any transaction completes, and Firestore rejects an explicit
      // undefined. (`startedAt: null` is fine — null is a legal value.)
      await db.collection("precisionSearchQueue").doc(queueItem.id).update({
        status: "pending",
        startedAt: null,
        transactionsProcessed,
        transactionsWithMatches,
        totalFilesConnected,
        ...(lastProcessedTransactionId !== undefined && {
          lastProcessedTransactionId,
        }),
        errors,
      });
      console.log(`[PrecisionSearch] Saved progress (${transactionsProcessed} processed), cron will continue`);
    } else {
      // Delete old and create new to trigger onDocumentCreated
      //
      // The four optional fields are spread conditionally rather than assigned:
      // Firestore rejects an explicit `undefined` value unless
      // ignoreUndefinedProperties is enabled, and this app never enables it
      // (pinned by test/firestore-parity.test.ts). Assigning them directly threw
      // "Cannot use \"undefined\" as a Firestore value" for any queue item that
      // needed a continuation without them — an all_incomplete scope has no
      // transactionId, and a manual run has no gmailSyncQueueId — which killed
      // the whole queue processor, not just that item.
      const continuationData = {
        userId: queueItem.userId,
        scope: queueItem.scope,
        ...(queueItem.transactionId !== undefined && {
          transactionId: queueItem.transactionId,
        }),
        triggeredBy: queueItem.triggeredBy,
        ...(queueItem.triggeredByAuthor !== undefined && {
          triggeredByAuthor: queueItem.triggeredByAuthor,
        }),
        ...(queueItem.gmailSyncQueueId !== undefined && {
          gmailSyncQueueId: queueItem.gmailSyncQueueId,
        }),
        status: "pending" as const,
        transactionsToProcess: queueItem.transactionsToProcess,
        transactionsProcessed,
        transactionsWithMatches,
        totalFilesConnected,
        ...(lastProcessedTransactionId !== undefined && {
          lastProcessedTransactionId,
        }),
        strategies: queueItem.strategies,
        currentStrategyIndex: 0,
        errors,
        retryCount: 0,
        maxRetries: queueItem.maxRetries,
        createdAt: Timestamp.now(),
      };

      await db.collection("precisionSearchQueue").doc(queueItem.id).delete();
      await db.collection("precisionSearchQueue").add(continuationData);
      console.log(`[PrecisionSearch] Created continuation (${transactionsProcessed} processed)`);
    }
  }

  async function completeQueueItem(): Promise<void> {
    const completedAt = Timestamp.now();

    await db.collection("precisionSearchQueue").doc(queueItem.id).update({
      status: "completed",
      transactionsProcessed,
      transactionsWithMatches,
      totalFilesConnected,
      lastProcessedTransactionId,
      errors,
      completedAt,
    });

    console.log(
      `[PrecisionSearch] Completed: ${totalFilesConnected} files connected, ` +
        `${transactionsWithMatches}/${transactionsProcessed} transactions matched`
    );
  }

  async function handleError(error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    if (queueItem.retryCount < queueItem.maxRetries) {
      if (queueItem.triggeredBy === "scheduled") {
        await db.collection("precisionSearchQueue").doc(queueItem.id).update({
          status: "pending",
          retryCount: queueItem.retryCount + 1,
          lastError: errorMsg,
          transactionsProcessed,
          transactionsWithMatches,
          totalFilesConnected,
          lastProcessedTransactionId,
          errors,
        });
      } else {
        // Create retry queue item
        const retryData = {
          userId: queueItem.userId,
          scope: queueItem.scope,
          transactionId: queueItem.transactionId,
          triggeredBy: queueItem.triggeredBy,
          triggeredByAuthor: queueItem.triggeredByAuthor,
          gmailSyncQueueId: queueItem.gmailSyncQueueId,
          status: "pending" as const,
          transactionsToProcess: queueItem.transactionsToProcess,
          transactionsProcessed,
          transactionsWithMatches,
          totalFilesConnected,
          lastProcessedTransactionId,
          strategies: queueItem.strategies,
          currentStrategyIndex: queueItem.currentStrategyIndex,
          errors,
          retryCount: queueItem.retryCount + 1,
          maxRetries: queueItem.maxRetries,
          lastError: errorMsg,
          createdAt: Timestamp.now(),
        };
        await db.collection("precisionSearchQueue").doc(queueItem.id).delete();
        await db.collection("precisionSearchQueue").add(retryData);
        console.log(`[PrecisionSearch] Created retry (attempt ${queueItem.retryCount + 1})`);
      }
    } else {
      await db.collection("precisionSearchQueue").doc(queueItem.id).update({
        status: "failed",
        lastError: errorMsg,
        transactionsProcessed,
        transactionsWithMatches,
        totalFilesConnected,
        errors,
        completedAt: Timestamp.now(),
      });
    }
  }
}

// ============================================================================
// Cloud Functions
// ============================================================================

/**
 * Process precision search queue every 5 minutes.
 */
export const processPrecisionSearchQueue = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: MAIL_PROVIDER_SECRETS,
  },
  async () => {
    console.log("[PrecisionSearch] Starting queue processor...");

    // The oldest pending queue items. A paused item goes back to pending with
    // its old createdAt, so it would be the oldest on every run; the run moves
    // past it to the next one instead of letting it hold up every other User.
    const pendingSnapshot = await db
      .collection("precisionSearchQueue")
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(PENDING_ITEMS_PER_RUN)
      .get();

    if (pendingSnapshot.empty) {
      console.log("[PrecisionSearch] No pending queue items");
      return;
    }

    for (const queueDoc of pendingSnapshot.docs) {
      const queueItem = {
        id: queueDoc.id,
        ...queueDoc.data(),
      } as PrecisionSearchQueueItem;

      // Mark as processing
      await queueDoc.ref.update({
        status: "processing",
        startedAt: Timestamp.now(),
      });

      try {
        const result = await processQueueItem(queueItem);
        if (!result.paused) return;
        console.log(`[PrecisionSearch] Queue item paused: ${result.pauseReason}`);
      } catch (error) {
        console.error("[PrecisionSearch] Queue processor error:", error);
        return;
      }
    }
  }
);

/**
 * Immediately start processing when a queue item is created.
 * This provides faster feedback for manual triggers.
 */
export const onPrecisionSearchQueueCreated = onDocumentCreated(
  {
    document: "precisionSearchQueue/{queueId}",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: MAIL_PROVIDER_SECRETS,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // Process manual and gmail_sync triggers immediately (scheduled waits for cron)
    if (data.triggeredBy === "scheduled") {
      console.log("[PrecisionSearch] Scheduled search, will be processed by cron");
      return;
    }

    const queueItem = {
      id: event.params.queueId,
      ...data,
    } as PrecisionSearchQueueItem;

    // Mark as processing
    await event.data?.ref.update({
      status: "processing",
      startedAt: Timestamp.now(),
    });

    try {
      const result = await processQueueItem(queueItem);
      if (result.paused) {
        console.log(`[PrecisionSearch] Queue item paused: ${result.pauseReason}`);
        // Don't retry - item is already set back to pending and will resume when the mailbox is reconnected
        return;
      }
    } catch (error) {
      console.error("[PrecisionSearch] Immediate processing error:", error);

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const retryCount = queueItem.retryCount || 0;
      const maxRetries = queueItem.maxRetries || 3;

      if (retryCount < maxRetries) {
        await event.data?.ref.update({
          status: "pending",
          retryCount: retryCount + 1,
          lastError: errorMessage,
        });
        console.log(`[PrecisionSearch] Marked for retry (${retryCount + 1}/${maxRetries})`);
      } else {
        await event.data?.ref.update({
          status: "failed",
          lastError: errorMessage,
          completedAt: Timestamp.now(),
        });
        console.log("[PrecisionSearch] Max retries exceeded, marked as failed");
      }
    }
  }
);
