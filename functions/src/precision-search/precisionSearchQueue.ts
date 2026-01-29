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
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import { analyzeEmailForInvoice } from "./geminiSearchHelper";
import { generateQueriesWithGemini } from "./generateQueriesWithGemini";
import { QueryGenerationPartner } from "./generateSearchQueries";
import { convertHtmlToPdf } from "./htmlToPdf";
import {
  scoreAttachmentMatch,
  ScoreAttachmentInput,
  ATTACHMENT_MATCH_THRESHOLD,
  GREAT_MATCH_THRESHOLD,
  GREAT_MATCH_COUNT,
} from "./scoreAttachmentMatch";
import {
  buildGmailSearchQuery,
} from "../gmail/searchGmailCallable";
import {
  classifyEmail,
  GmailAttachment,
} from "./shared-utils";

const db = getFirestore();
const storage = getStorage();

// ============================================================================
// Constants
// ============================================================================

const PROCESSING_TIMEOUT_MS = 240000; // 4 minutes (leave buffer for 5 min timeout)
const TRANSACTIONS_PER_BATCH = 20; // Process 20 transactions per invocation
const REQUEST_DELAY_MS = 200; // Rate limiting for Gmail API

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
  partnerId?: string;
  transactionIds?: string[];
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
}

interface EmailIntegration {
  id: string;
  userId: string;
  email: string;
  isActive: boolean;
  needsReauth: boolean;
  isPaused?: boolean;
}

/**
 * Check if Gmail is connected but needs reauthentication.
 * Returns true if processing should be paused (Gmail connected but needs reauth).
 * Returns false if:
 * - No Gmail integrations exist (proceed with non-email strategies)
 * - Gmail is connected and healthy (proceed normally)
 */
async function shouldPauseForGmailReauth(userId: string): Promise<{
  shouldPause: boolean;
  reason?: string;
  integrationEmail?: string;
}> {
  // Check for any email integrations that need reauth
  const needsReauthSnapshot = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .where("needsReauth", "==", true)
    .limit(1)
    .get();

  if (!needsReauthSnapshot.empty) {
    const integration = needsReauthSnapshot.docs[0].data() as EmailIntegration;
    return {
      shouldPause: true,
      reason: "Gmail connected but needs reconnection",
      integrationEmail: integration.email,
    };
  }

  return { shouldPause: false };
}

interface EmailTokenDocument {
  accessToken: string;
  refreshToken: string;
  expiresAt: Timestamp;
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string; // Gmail API's short plain-text summary
  payload: {
    headers: Array<{ name: string; value: string }>;
    parts?: GmailPart[];
    body?: { attachmentId?: string; size?: number; data?: string };
    mimeType: string;
  };
}

interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  body: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

// GmailAttachment imported from ./shared-utils

interface SearchAttempt {
  strategy: SearchStrategy;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  searchParams: Record<string, unknown>;
  candidatesFound: number;
  candidatesEvaluated: number;
  matchesFound: number;
  fileIdsConnected: string[];
  bestMatchScore?: number; // Track the best score to decide if we should stop searching
  invoiceLinksFound?: string[];
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

async function sha256(data: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function extractHeader(message: GmailMessage, headerName: string): string | null {
  const header = message.payload.headers.find(
    (h) => h.name.toLowerCase() === headerName.toLowerCase()
  );
  return header?.value || null;
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
 * Check if a file was rejected by the transaction (user manually removed it)
 */
function isFileRejectedByTransaction(fileId: string, transaction: Transaction): boolean {
  return (transaction.rejectedFileIds || []).includes(fileId);
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

/**
 * Extract ALL attachments from message (same as UI - no MIME type filtering)
 * The scoring logic decides what's relevant later
 */
function extractAttachments(message: GmailMessage): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  function processPartsRecursively(parts: GmailPart[] | undefined): void {
    if (!parts) return;

    for (const part of parts) {
      // Extract ALL attachments, not just invoice types
      // Same behavior as UI's GmailClient.extractAttachments
      if (part.body?.attachmentId && part.filename) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size || 0,
          isLikelyReceipt: isLikelyReceiptAttachment(part.filename, part.mimeType),
        });
      }
      if (part.parts) {
        processPartsRecursively(part.parts);
      }
    }
  }

  processPartsRecursively(message.payload.parts);
  return attachments;
}

function extractEmailBody(message: GmailMessage): { html?: string; text?: string } {
  let html: string | undefined;
  let text: string | undefined;

  function processPartsRecursively(parts: GmailPart[] | undefined): void {
    if (!parts) return;

    for (const part of parts) {
      if (part.body?.data) {
        const decoded = Buffer.from(
          part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64"
        ).toString("utf-8");

        if (part.mimeType === "text/html") {
          html = decoded;
        } else if (part.mimeType === "text/plain") {
          text = decoded;
        }
      }
      if (part.parts) {
        processPartsRecursively(part.parts);
      }
    }
  }

  // Check main body first
  if (message.payload.body?.data) {
    const decoded = Buffer.from(
      message.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");

    if (message.payload.mimeType === "text/html") {
      html = decoded;
    } else if (message.payload.mimeType === "text/plain") {
      text = decoded;
    }
  }

  processPartsRecursively(message.payload.parts);

  return { html, text };
}

// ============================================================================
// Gmail API Client
// ============================================================================

class GmailApiClient {
  private accessToken: string;
  private lastRequestTime = 0;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await sleep(REQUEST_DELAY_MS - elapsed + Math.random() * 50);
    }
    this.lastRequestTime = Date.now();
  }

  async searchMessages(
    query: string,
    maxResults = 20
  ): Promise<{ messages: Array<{ id: string }>; nextPageToken?: string }> {
    await this.waitForRateLimit();

    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gmail search failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      messages: data.messages || [],
      nextPageToken: data.nextPageToken,
    };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    await this.waitForRateLimit();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Gmail get message failed: ${response.status}`);
    }

    return response.json();
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    await this.waitForRateLimit();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Gmail get attachment failed: ${response.status}`);
    }

    const data = await response.json();
    const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64");
  }
}

/**
 * Get active Gmail clients for a user
 */
async function getGmailClientsForUser(
  userId: string
): Promise<Array<{ client: GmailApiClient; integration: EmailIntegration }>> {
  const integrationsSnapshot = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .where("needsReauth", "==", false)
    .limit(5)
    .get();

  if (integrationsSnapshot.empty) {
    return [];
  }

  const clients: Array<{ client: GmailApiClient; integration: EmailIntegration }> = [];

  for (const doc of integrationsSnapshot.docs) {
    const integration = { id: doc.id, ...doc.data() } as EmailIntegration;

    // Get token
    const tokenDoc = await db.collection("emailTokens").doc(integration.id).get();
    if (!tokenDoc.exists) continue;

    const tokenData = tokenDoc.data() as EmailTokenDocument;

    // Check if token is expired
    if (tokenData.expiresAt.toDate() < new Date()) {
      // Mark as needing reauth
      await db.collection("emailIntegrations").doc(integration.id).update({
        needsReauth: true,
        lastError: "Access token expired",
        updatedAt: Timestamp.now(),
      });
      continue;
    }

    clients.push({
      client: new GmailApiClient(tokenData.accessToken),
      integration,
    });
  }

  return clients;
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
  message: GmailMessage,
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

    // Check if file was soft-deleted
    if (existingData.deletedAt) {
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
  const from = extractHeader(message, "From") || "";
  const subject = extractHeader(message, "Subject") || "";
  const emailDate = new Date(parseInt(message.internalDate, 10));
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = emailMatch[1] || from;
  const senderDomain = extractEmailDomain(senderEmail);
  const senderName = from.replace(/<[^>]+>/, "").trim().replace(/"/g, "");

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
        gmailMessageId: messageId,
        gmailIntegrationId: integrationId,
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  // Generate download URL
  let downloadUrl: string;
  const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const encodedPath = encodeURIComponent(storagePath);

  if (storageEmulatorHost) {
    downloadUrl = `http://${storageEmulatorHost}/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  } else {
    downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  }

  // Create file document
  const now = Timestamp.now();
  const fileData: Record<string, unknown> = {
    userId,
    fileName: attachment.filename,
    fileType: contentType, // Use corrected MIME type
    fileSize: attachment.size,
    storagePath,
    downloadUrl,
    contentHash,
    sourceType: "gmail",
    gmailMessageId: messageId,
    gmailIntegrationId: integrationId,
    gmailIntegrationEmail: integrationEmail,
    gmailSubject: subject,
    gmailAttachmentId: attachment.attachmentId,
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

  const fileRef = await db.collection("files").add(fileData);

  console.log(`[PrecisionSearch] Created file: ${attachment.filename} (${fileRef.id})${precisionSearchHint ? ` [hint: tx ${precisionSearchHint.transactionId}]` : ""}`);
  return fileRef.id;
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
  message: GmailMessage,
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

    // Check if file was soft-deleted
    if (existingData.deletedAt) {
      // Undelete the file and update its metadata + add precision search hint
      console.log(`[PrecisionSearch] Undeleting soft-deleted PDF: ${filename} (${existingDoc.id})`);
      const updateData: Record<string, unknown> = {
        deletedAt: null,
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
  const from = extractHeader(message, "From") || "";
  const subject = extractHeader(message, "Subject") || "";
  const emailDate = new Date(parseInt(message.internalDate, 10));
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = emailMatch[1] || from;
  const senderDomain = extractEmailDomain(senderEmail);
  const senderName = from.replace(/<[^>]+>/, "").trim().replace(/"/g, "");

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
        gmailMessageId: message.id,
        gmailIntegrationId: integrationId,
        convertedFromHtml: "true",
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  // Generate download URL
  let downloadUrl: string;
  const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const encodedPath = encodeURIComponent(storagePath);

  if (storageEmulatorHost) {
    downloadUrl = `http://${storageEmulatorHost}/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  } else {
    downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  }

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
    gmailMessageId: message.id,
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

  const fileRef = await db.collection("files").add(fileData);

  console.log(`[PrecisionSearch] Created HTML-converted PDF: ${filename} (${fileRef.id})${precisionSearchHint ? ` [hint: tx ${precisionSearchHint.transactionId}]` : ""}`);
  return fileRef.id;
}

// ============================================================================
// Strategy Execution
// ============================================================================

/**
 * Execute Strategy 1: Partner Files Matching
 * Find unassociated files from the same partner and match by amount/date
 */
async function executePartnerFilesStrategy(
  transaction: Transaction,
  userId: string
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "partner_files",
    startedAt,
    searchParams: { partnerId: transaction.partnerId },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
  };

  try {
    // Skip if transaction has no partner
    if (!transaction.partnerId) {
      console.log(`[PrecisionSearch] partner_files: Skipped - no partnerId on transaction ${transaction.id}`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Get partner info if available
    let partnerInfo: { name?: string; emailDomains?: string[] } | undefined;
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
        };
      }
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
      .filter((f) => !f.transactionIds || f.transactionIds.length === 0);

    attempt.candidatesFound = unassociatedFiles.length;
    console.log(`[PrecisionSearch] partner_files: Found ${filesSnapshot.size} files for partner, ${unassociatedFiles.length} unassociated`);

    if (unassociatedFiles.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Score files against transaction using unified scoring (same as UI)
    for (const file of unassociatedFiles) {
      attempt.candidatesEvaluated++;

      const scoreInput: ScoreAttachmentInput = {
        filename: file.fileName || "unknown",
        mimeType: file.fileType || "application/pdf",
        emailBodyText: file.extractedText, // Treat OCR text as body
        emailDate: file.extractedDate?.toDate(),
        // File extracted data for numeric comparison
        fileExtractedAmount: file.extractedAmount,
        fileExtractedDate: file.extractedDate?.toDate(),
        fileExtractedPartner: file.extractedPartner,
        // Transaction data
        transactionAmount: transaction.amount,
        transactionDate: transaction.date.toDate(),
        transactionName: transaction.name,
        transactionReference: transaction.reference,
        transactionPartner: transaction.partner,
        partnerName: partnerInfo?.name,
        partnerEmailDomains: partnerInfo?.emailDomains,
      };

      const score = scoreAttachmentMatch(scoreInput);
      console.log(
        `[PrecisionSearch] Match score for file ${file.fileName} (${file.id}): ${score.score}% ` +
        `[${score.reasons.slice(0, 3).join(", ")}]`
      );

      // Only connect if score meets threshold (same as UI)
      // Track best score
      if (!attempt.bestMatchScore || score.score > attempt.bestMatchScore) {
        attempt.bestMatchScore = score.score;
      }

      if (score.score < ATTACHMENT_MATCH_THRESHOLD) {
        continue;
      }

      // Check if this file was rejected by the transaction (user manually removed it)
      if (isFileRejectedByTransaction(file.id, transaction)) {
        console.log(`[PrecisionSearch] Skipping rejected file ${file.fileName} (${file.id})`);
        continue;
      }

      // Match found! Add hint and re-trigger matching logic
      await db.collection("files").doc(file.id).update({
        precisionSearchHint: {
          transactionId: transaction.id,
          transactionAmount: transaction.amount,
          transactionDate: transaction.date,
          searchStrategy: "partner_files",
          matchConfidence: score.score,
          searchedAt: Timestamp.now(),
        },
        transactionMatchComplete: false, // Re-trigger matching
        updatedAt: Timestamp.now(),
      });
      attempt.fileIdsConnected.push(file.id);
      attempt.matchesFound++;
      // Continue to find more candidates
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
 * Execute Strategy 2: Amount Files Matching
 * Search all unassociated files by amount/date range
 */
async function executeAmountFilesStrategy(
  transaction: Transaction,
  userId: string
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "amount_files",
    startedAt,
    searchParams: {
      amount: transaction.amount,
      dateRange: {
        from: transaction.date.toDate().toISOString(),
        to: transaction.date.toDate().toISOString(),
      },
    },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
  };

  try {
    // Calculate date range (±90 days - wider since UI scoring has date multiplier)
    const txDate = transaction.date.toDate();
    const dateFrom = new Date(txDate);
    dateFrom.setDate(dateFrom.getDate() - 90);
    const dateTo = new Date(txDate);
    dateTo.setDate(dateTo.getDate() + 90);

    // Query files in date range
    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("extractionComplete", "==", true)
      .where("extractedDate", ">=", Timestamp.fromDate(dateFrom))
      .where("extractedDate", "<=", Timestamp.fromDate(dateTo))
      .limit(100)
      .get();

    // Filter to unassociated non-deleted files
    const candidates = filesSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as TaxFile)
      .filter((f) => !f.deletedAt) // Exclude soft-deleted files
      .filter((f) => !f.transactionIds || f.transactionIds.length === 0);

    console.log(`[PrecisionSearch] amount_files: Query returned ${filesSnapshot.size} files in date range, ${candidates.length} unassociated`);

    if (candidates.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Score all candidates using unified scoring (same as UI)
    const scoredCandidates = candidates
      .map((file) => {
        const scoreInput: ScoreAttachmentInput = {
          filename: file.fileName || "unknown",
          mimeType: file.fileType || "application/pdf",
          emailBodyText: file.extractedText,
          emailDate: file.extractedDate?.toDate(),
          // File extracted data for numeric comparison
          fileExtractedAmount: file.extractedAmount,
          fileExtractedDate: file.extractedDate?.toDate(),
          fileExtractedPartner: file.extractedPartner,
          // Transaction data
          transactionAmount: transaction.amount,
          transactionDate: txDate,
          transactionName: transaction.name,
          transactionReference: transaction.reference,
          transactionPartner: transaction.partner,
        };
        const score = scoreAttachmentMatch(scoreInput);
        return { file, score };
      })
      .filter((c) => c.score.score >= ATTACHMENT_MATCH_THRESHOLD)
      .sort((a, b) => b.score.score - a.score.score);

    attempt.candidatesFound = scoredCandidates.length;
    attempt.candidatesEvaluated = candidates.length;

    // Track best score (array is sorted by score descending)
    if (scoredCandidates.length > 0) {
      attempt.bestMatchScore = scoredCandidates[0].score.score;
    }

    // Log all scores for debugging
    for (const { file, score } of scoredCandidates.slice(0, 5)) {
      console.log(
        `[PrecisionSearch] Match score for file ${file.fileName} (${file.id}): ${score.score}% ` +
        `[${score.reasons.slice(0, 3).join(", ")}]`
      );
    }

    if (scoredCandidates.length === 0) {
      console.log(`[PrecisionSearch] amount_files: No files meet ${ATTACHMENT_MATCH_THRESHOLD}% threshold`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    // Add hints to top candidates and re-trigger matching (skip rejected files)
    const topCandidates = scoredCandidates
      .filter(({ file }) => !isFileRejectedByTransaction(file.id, transaction))
      .slice(0, 3); // Top 3 non-rejected matches

    for (const { file: candidate, score } of topCandidates) {
      await db.collection("files").doc(candidate.id).update({
        precisionSearchHint: {
          transactionId: transaction.id,
          transactionAmount: transaction.amount,
          transactionDate: transaction.date,
          searchStrategy: "amount_files",
          matchConfidence: score.score,
          searchedAt: Timestamp.now(),
        },
        transactionMatchComplete: false, // Re-trigger matching
        updatedAt: Timestamp.now(),
      });
      attempt.fileIdsConnected.push(candidate.id);
      attempt.matchesFound++;
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
 * Execute Strategy 3: Email Attachment Search
 * Search Gmail for attachments that could match using Gemini-generated queries
 */
async function executeEmailAttachmentStrategy(
  transaction: Transaction,
  userId: string
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "email_attachment",
    startedAt,
    searchParams: { transactionName: transaction.name },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    geminiCalls: 0,
    geminiTokensUsed: 0,
  };

  try {
    // Get Gmail clients
    const clients = await getGmailClientsForUser(userId);
    if (clients.length === 0) {
      console.log(`[PrecisionSearch] email_attachment: No active Gmail integrations for user`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }
    console.log(`[PrecisionSearch] email_attachment: Found ${clients.length} Gmail integration(s)`);

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

    // Generate search queries using Gemini (same as UI)
    const allQueries = await generateQueriesWithGemini(
      {
        name: transaction.name,
        partner: transaction.partner,
        description: transaction.description,
        reference: transaction.reference,
        amount: transaction.amount,
      },
      partnerInfo
    );

    // Take first 3 queries
    const queries = allQueries.slice(0, 3);
    console.log(`[PrecisionSearch] email_attachment: Using ${queries.length} Gemini queries for tx "${transaction.name}":`, queries);

    if (queries.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    attempt.searchParams = {
      ...attempt.searchParams,
      queries,
    };

    // Search each Gmail account with each query
    // NOTE: Don't add date filter to Gmail query - let Gmail rank by relevance (same as UI)
    // We filter by date AFTER fetching (see isEmailDateInRange check below)
    const processedMessageIds = new Set<string>();
    const txDate = transaction.date.toDate();
    let greatMatchCount = 0; // Stop trying more queries after GREAT_MATCH_COUNT matches at GREAT_MATCH_THRESHOLD%

    for (const { client, integration } of clients) {
      if (greatMatchCount >= GREAT_MATCH_COUNT) break;
      for (const query of queries) {
        if (greatMatchCount >= GREAT_MATCH_COUNT) break;
        try {
          // Use shared query builder (same as UI callable) - no date filter, let Gmail rank by relevance
          const fullQuery = buildGmailSearchQuery({
            query,
            hasAttachments: true,
          });

          const searchResult = await client.searchMessages(fullQuery, 20);
          console.log(`[PrecisionSearch] email_attachment: Query "${query.substring(0, 50)}..." returned ${searchResult.messages.length} messages`);
          attempt.candidatesFound += searchResult.messages.length;

          for (const { id: messageId } of searchResult.messages) {
            // Skip already processed messages
            if (processedMessageIds.has(messageId)) continue;
            processedMessageIds.add(messageId);

            attempt.candidatesEvaluated++;

            try {
              const message = await client.getMessage(messageId);

              // Verify email date is within range (extra safety check)
              const emailDate = new Date(parseInt(message.internalDate, 10));
              if (!isEmailDateInRange(emailDate, txDate, 180)) {
                console.log(`[PrecisionSearch] Skipping message - date ${emailDate.toISOString().split("T")[0]} outside ±180 days of tx`);
                continue;
              }

              const allAttachments = extractAttachments(message);

              // Classify email BEFORE processing attachments
              const subject = extractHeader(message, "Subject") || "";
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

              // Filter to likely receipts (PDFs, images) for processing
              // Same behavior as UI which shows all attachments but highlights likely receipts
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
                const existingFileQuery = await db
                  .collection("files")
                  .where("userId", "==", userId)
                  .where("gmailMessageId", "==", messageId)
                  .where("gmailAttachmentId", "==", attachment.attachmentId)
                  .limit(1)
                  .get();

                if (!existingFileQuery.empty) {
                  // File already exists - score it and potentially connect to transaction
                  const existingDoc = existingFileQuery.docs[0];
                  const existingFile = { id: existingDoc.id, ...existingDoc.data() } as TaxFile;
                  const fileName = existingFile.fileName || attachment.filename;

                  // Skip if already connected to this transaction
                  if (existingFile.transactionIds?.includes(transaction.id)) {
                    console.log(`[PrecisionSearch] File already connected: ${fileName}`);
                    continue;
                  }

                  // Score the existing file using unified scoring (same as UI)
                  // Include email metadata for better scoring
                  const from = extractHeader(message, "From") || "";
                  const subject = extractHeader(message, "Subject") || "";
                  const emailDate = new Date(parseInt(message.internalDate, 10));

                  const scoreInput: ScoreAttachmentInput = {
                    filename: fileName,
                    mimeType: attachment.mimeType,
                    emailSubject: subject,
                    emailFrom: from,
                    emailBodyText: existingFile.extractedText,
                    emailDate,
                    integrationId: integration.id,
                    transactionAmount: transaction.amount,
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
                const attachmentData = await client.getAttachment(messageId, attachment.attachmentId);
                const result = await createFileFromAttachment(
                  userId,
                  attachmentData,
                  attachment,
                  message,
                  integration.id,
                  integration.email,
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
                      const from = extractHeader(message, "From") || "";
                      const subject = extractHeader(message, "Subject") || "";
                      const emailDate = new Date(parseInt(message.internalDate, 10));

                      const scoreInput: ScoreAttachmentInput = {
                        filename: fileName,
                        mimeType: attachment.mimeType,
                        emailSubject: subject,
                        emailFrom: from,
                        emailBodyText: existingFile.extractedText,
                        emailDate,
                        integrationId: integration.id,
                        transactionAmount: transaction.amount,
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
                    if (isPdf) foundPdfMatch = true;
                  }
                }
              }
            } catch (msgError) {
              console.error(`[PrecisionSearch] Error processing message ${messageId}:`, msgError);
            }
          }
        } catch (searchError) {
          console.error(`[PrecisionSearch] Error searching with query "${query}":`, searchError);
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
 * Parse email content for invoice links or HTML invoices
 */
async function executeEmailInvoiceStrategy(
  transaction: Transaction,
  userId: string
): Promise<SearchAttempt> {
  const startedAt = Timestamp.now();
  const attempt: SearchAttempt = {
    strategy: "email_invoice",
    startedAt,
    searchParams: { transactionName: transaction.name, partnerId: transaction.partnerId },
    candidatesFound: 0,
    candidatesEvaluated: 0,
    matchesFound: 0,
    fileIdsConnected: [],
    invoiceLinksFound: [],
    geminiCalls: 0,
    geminiTokensUsed: 0,
  };

  try {
    // Get Gmail clients
    const clients = await getGmailClientsForUser(userId);
    if (clients.length === 0) {
      console.log(`[PrecisionSearch] email_invoice: No active Gmail integrations for user`);
      attempt.completedAt = Timestamp.now();
      return attempt;
    }
    console.log(`[PrecisionSearch] email_invoice: Found ${clients.length} Gmail integration(s)`);

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

    // Generate search queries using Gemini (same as UI)
    const allQueries = await generateQueriesWithGemini(
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
      } : undefined
    );

    // Take first 3 queries (same as clicking suggestions in UI)
    const queries = allQueries.slice(0, 3);
    console.log(`[PrecisionSearch] email_invoice: Using ${queries.length} queries for tx "${transaction.name}":`, queries);

    if (queries.length === 0) {
      attempt.completedAt = Timestamp.now();
      return attempt;
    }

    attempt.searchParams = {
      ...attempt.searchParams,
      queries,
    };

    // Search each Gmail account with each query (exclude attachment requirement)
    // NOTE: Don't add date filter to Gmail query - let Gmail rank by relevance (same as UI)
    // We filter by date AFTER fetching (see isEmailDateInRange check below)
    const processedMessageIds = new Set<string>();
    const txDate = transaction.date.toDate();
    let greatMatchCount = 0; // Stop trying more queries after GREAT_MATCH_COUNT matches at GREAT_MATCH_THRESHOLD%

    for (const { client, integration } of clients) {
      if (greatMatchCount >= GREAT_MATCH_COUNT) break;
      for (const query of queries) {
        if (greatMatchCount >= GREAT_MATCH_COUNT) break;
        try {
          // Use shared query builder (same as UI callable) - no date filter, no attachment requirement
          const cleanQuery = buildGmailSearchQuery({
            query: query.replace(/has:attachment/gi, "").trim(),
            hasAttachments: false,
          });

          const searchResult = await client.searchMessages(cleanQuery, 20);
          console.log(`[PrecisionSearch] email_invoice: Query "${cleanQuery.substring(0, 50)}..." returned ${searchResult.messages.length} messages`);
          attempt.candidatesFound += searchResult.messages.length;

          for (const { id: messageId } of searchResult.messages) {
            if (processedMessageIds.has(messageId)) continue;
            processedMessageIds.add(messageId);

            attempt.candidatesEvaluated++;

            try {
              const message = await client.getMessage(messageId);
              const from = extractHeader(message, "From") || "";
              const subject = extractHeader(message, "Subject") || "";

              // Pre-classify email to prioritize likely mail invoices
              const allAttachments = extractAttachments(message);
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
              const emailDate = new Date(parseInt(message.internalDate, 10));
              if (!isEmailDateInRange(emailDate, txDate, 180)) {
                console.log(`[PrecisionSearch] Skipping message - date ${emailDate.toISOString().split("T")[0]} outside ±180 days of tx`);
                continue;
              }

              const { html, text } = extractEmailBody(message);

              // Analyze email content with Gemini
              const analysis = await analyzeEmailForInvoice(
                { subject, from, htmlBody: html, textBody: text },
                {
                  name: transaction.name,
                  partner: transaction.partner,
                  amount: transaction.amount,
                }
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
                // Verify email date is within range of transaction (extra safety check)
                const emailDate = new Date(parseInt(message.internalDate, 10));
                if (!isEmailDateInRange(emailDate, txDate, 180)) {
                  console.log(`[PrecisionSearch] Skipping email invoice - date ${emailDate.toISOString()} outside ±180 days of tx ${txDate.toISOString()}`);
                  continue;
                }

                // Score the email using unified scoring (same as UI)
                // Use message.snippet from Gmail API (same as UI), with body text as fallback
                const bodyText = text || (html ? html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : undefined);
                const emailScoreInput: ScoreAttachmentInput = {
                  filename: `${subject}.pdf`,
                  mimeType: "application/pdf",
                  emailSubject: subject,
                  emailFrom: from,
                  // Use snippet from Gmail API like UI does, fallback to extracted body
                  emailSnippet: message.snippet || bodyText?.substring(0, 500),
                  emailBodyText: bodyText,
                  emailDate,
                  integrationId: integration.id,
                  transactionAmount: transaction.amount,
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
                const existingFile = await db
                  .collection("files")
                  .where("userId", "==", userId)
                  .where("gmailMessageId", "==", messageId)
                  .where("sourceType", "==", "gmail_html_invoice")
                  .limit(1)
                  .get();

                if (existingFile.empty) {
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
                    integration.id,
                    integration.email,
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
              console.error(`[PrecisionSearch] Error processing message ${messageId}:`, msgError);
            }
          }
        } catch (searchError) {
          console.error(`[PrecisionSearch] Error searching with query "${query}":`, searchError);
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
  userId: string
): Promise<SearchAttempt> {
  switch (strategy) {
    case "partner_files":
      return executePartnerFilesStrategy(transaction, userId);
    case "amount_files":
      return executeAmountFilesStrategy(transaction, userId);
    case "email_attachment":
      return executeEmailAttachmentStrategy(transaction, userId);
    case "email_invoice":
      return executeEmailInvoiceStrategy(transaction, userId);
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

async function processQueueItem(queueItem: PrecisionSearchQueueItem): Promise<{
  paused?: boolean;
  pauseReason?: string;
}> {
  const startTime = Date.now();
  console.log(
    `[PrecisionSearch] Processing queue ${queueItem.id} (${queueItem.scope}, ${queueItem.triggeredBy})`
  );

  // Check if Gmail needs reauth - pause processing to avoid incomplete searches
  const gmailStatus = await shouldPauseForGmailReauth(queueItem.userId);
  if (gmailStatus.shouldPause) {
    console.log(
      `[PrecisionSearch] Pausing queue ${queueItem.id}: ${gmailStatus.reason} (${gmailStatus.integrationEmail})`
    );
    // Revert to pending so it will be picked up again after Gmail reconnection
    await db.collection("precisionSearchQueue").doc(queueItem.id).update({
      status: "pending",
      startedAt: null,
      lastError: `Paused: ${gmailStatus.reason}. Will resume when Gmail is reconnected.`,
    });
    return { paused: true, pauseReason: gmailStatus.reason };
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

      try {
        let foundMatch = false;

        // Run strategies in order until one finds a match
        // Threshold for stopping early - only stop if we find a very strong match
        // Set high because attachment scoring and transaction scoring can diverge
        const STRONG_MATCH_THRESHOLD = 85;

        for (const strategy of queueItem.strategies) {
          // Skip if transaction already completed
          if (tx.isComplete) break;

          const attempt = await executeStrategy(strategy, tx, queueItem.userId);

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
      await db.collection("precisionSearchQueue").doc(queueItem.id).update({
        status: "pending",
        startedAt: null,
        transactionsProcessed,
        transactionsWithMatches,
        totalFilesConnected,
        lastProcessedTransactionId,
        errors,
      });
      console.log(`[PrecisionSearch] Saved progress (${transactionsProcessed} processed), cron will continue`);
    } else {
      // Delete old and create new to trigger onDocumentCreated
      const continuationData = {
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
  },
  async () => {
    console.log("[PrecisionSearch] Starting queue processor...");

    // Get oldest pending queue item
    const pendingSnapshot = await db
      .collection("precisionSearchQueue")
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();

    if (pendingSnapshot.empty) {
      console.log("[PrecisionSearch] No pending queue items");
      return;
    }

    const queueDoc = pendingSnapshot.docs[0];
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
      if (result.paused) {
        console.log(`[PrecisionSearch] Queue item paused: ${result.pauseReason}`);
      }
    } catch (error) {
      console.error("[PrecisionSearch] Queue processor error:", error);
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
        // Don't retry - item is already set back to pending and will resume when Gmail reconnects
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
