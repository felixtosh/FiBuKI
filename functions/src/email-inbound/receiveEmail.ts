/**
 * Inbound Email Webhook
 *
 * Receives emails forwarded to user's unique FiBuKI email address.
 * Processes attachments and converts email body to PDF.
 *
 * Designed for SendGrid Inbound Parse webhook.
 */

import { onRequest } from "firebase-functions/v2/https";
import { buildStorageObjectUrl } from "../utils/buildDownloadUrl";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import Busboy from "busboy";
import { simpleParser, ParsedMail, Attachment, AddressObject } from "mailparser";
import { convertHtmlToPdf } from "../precision-search/htmlToPdf";

const db = getFirestore();
const storage = getStorage();

// ============================================================================
// Constants
// ============================================================================

const INBOUND_ADDRESSES_COLLECTION = "inboundEmailAddresses";
const INBOUND_LOGS_COLLECTION = "inboundEmailLogs";
const FILES_COLLECTION = "files";

const INBOUND_EMAIL_DOMAIN = "fibuki.com";

/** Supported attachment MIME types */
const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

/** Map file extension to proper MIME type */
function getMimeTypeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeMap: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return ext ? mimeMap[ext] || null : null;
}

/** Check if attachment is supported (by MIME type or extension) */
function isSupportedAttachment(contentType: string | undefined, filename: string | undefined): { supported: boolean; mimeType: string } {
  // Check by MIME type first
  if (contentType && SUPPORTED_MIME_TYPES.includes(contentType)) {
    return { supported: true, mimeType: contentType };
  }

  // If MIME type is generic/unknown, check by extension
  if (filename && (contentType === "application/octet-stream" || !contentType)) {
    const inferredMime = getMimeTypeFromExtension(filename);
    if (inferredMime) {
      return { supported: true, mimeType: inferredMime };
    }
  }

  return { supported: false, mimeType: contentType || "unknown" };
}

/** Maximum attachment size (10MB) */
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

interface InboundEmailAddress {
  id: string;
  userId: string;
  email: string;
  emailPrefix: string;
  isActive: boolean;
  emailsReceived?: number;
  filesCreated?: number;
  allowedDomains?: string[];
  dailyLimit: number;
  todayCount: number;
  todayDate?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract email prefix from recipient address
 * e.g., "invoices-abc123@fibuki.com" -> "abc123"
 * Preserves original case since Firestore queries are case-sensitive
 */
function extractEmailPrefix(email: string): string | null {
  const pattern = `invoices-([a-zA-Z0-9_-]+)@${INBOUND_EMAIL_DOMAIN}`;
  const match = email.match(new RegExp(pattern, "i"));
  console.log(`[receiveEmail] extractEmailPrefix: email="${email}", pattern="${pattern}", match=${match ? match[1] : "null"}`);
  return match ? match[1] : null;
}

/**
 * Extract domain from email address
 */
function extractDomain(email: string): string | null {
  const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : null;
}

/**
 * Get today's date as YYYY-MM-DD
 */
function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Look up inbound address by email prefix
 */
async function lookupInboundAddress(
  emailPrefix: string
): Promise<InboundEmailAddress | null> {
  const snapshot = await db
    .collection(INBOUND_ADDRESSES_COLLECTION)
    .where("emailPrefix", "==", emailPrefix)
    .where("isActive", "==", true)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as InboundEmailAddress;
}

/**
 * Check if sender domain is allowed
 */
function isSenderAllowed(
  address: InboundEmailAddress,
  senderEmail: string
): boolean {
  if (!address.allowedDomains || address.allowedDomains.length === 0) {
    return true;
  }

  const senderDomain = extractDomain(senderEmail);
  if (!senderDomain) {
    return false;
  }

  return address.allowedDomains.some(
    (d) => d.toLowerCase() === senderDomain.toLowerCase()
  );
}

/**
 * Check if within daily rate limit
 */
function isWithinRateLimit(address: InboundEmailAddress): boolean {
  const today = getTodayDate();

  // Reset count if new day
  if (address.todayDate !== today) {
    return true;
  }

  return address.todayCount < address.dailyLimit;
}

/**
 * Check for duplicate email (by Message-ID header)
 */
async function isDuplicate(
  addressId: string,
  messageId: string
): Promise<boolean> {
  const snapshot = await db
    .collection(INBOUND_LOGS_COLLECTION)
    .where("inboundAddressId", "==", addressId)
    .where("messageId", "==", messageId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * Drop optional fields that are absent: Firestore rejects undefined values
 * (ignoreUndefinedProperties is never enabled), so fromName /
 * bodyConvertedToFile / inboundFromName must be omitted, not written as
 * undefined. Shallow on purpose — these writers take flat payloads.
 */
function omitUndefined<T extends Record<string, unknown>>(data: T): T {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  ) as T;
}

/**
 * Create log entry
 */
async function createLogEntry(
  data: Omit<
    {
      userId: string;
      inboundAddressId: string;
      messageId: string;
      from: string;
      fromName?: string;
      subject: string;
      receivedAt: Timestamp;
      status: string;
      filesCreated: string[];
      bodyConvertedToFile?: string;
      attachmentsProcessed: number;
      error?: string;
      rejectionReason?: string;
    },
    "createdAt"
  >
): Promise<string> {
  const docRef = await db.collection(INBOUND_LOGS_COLLECTION).add(
    omitUndefined({
      ...data,
      createdAt: Timestamp.now(),
    })
  );
  return docRef.id;
}

/**
 * Update inbound address stats
 */
async function updateAddressStats(
  addressId: string,
  filesCreated: number
): Promise<void> {
  const docRef = db.collection(INBOUND_ADDRESSES_COLLECTION).doc(addressId);
  const doc = await docRef.get();

  if (!doc.exists) return;

  const data = doc.data() as InboundEmailAddress;
  const today = getTodayDate();

  await docRef.update({
    emailsReceived: (data.emailsReceived || 0) + 1,
    filesCreated: (data.filesCreated || 0) + filesCreated,
    lastEmailAt: Timestamp.now(),
    todayCount: data.todayDate === today ? data.todayCount + 1 : 1,
    todayDate: today,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Sanitize filename for storage
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 100);
}

/**
 * Upload file to Firebase Storage
 */
async function uploadToStorage(
  userId: string,
  filename: string,
  buffer: Buffer,
  contentType: string
): Promise<{ storagePath: string; downloadUrl: string }> {
  const timestamp = Date.now();
  const sanitizedName = sanitizeFilename(filename);
  const storagePath = `files/${userId}/${timestamp}_${sanitizedName}`;

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  await file.save(buffer, {
    contentType,
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });

  // Make file publicly accessible
  await file.makePublic();

  const downloadUrl = buildStorageObjectUrl(bucket.name, storagePath);

  return { storagePath, downloadUrl };
}

/**
 * Create file document in Firestore
 */
async function createFileDocument(data: {
  userId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storagePath: string;
  downloadUrl: string;
  contentHash: string;
  sourceType: "email_inbound" | "email_inbound_body";
  inboundEmailId: string;
  inboundEmailAddress: string;
  inboundMessageId: string;
  inboundFrom: string;
  inboundFromName?: string;
  inboundSubject: string;
  inboundReceivedAt: Timestamp;
}): Promise<string> {
  const now = Timestamp.now();

  const docRef = await db.collection(FILES_COLLECTION).add(
    omitUndefined({
      ...data,
      extractionComplete: false,
      transactionIds: [],
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  );

  return docRef.id;
}

/**
 * Check if file already exists (by content hash)
 */
async function fileExistsByHash(
  userId: string,
  contentHash: string
): Promise<boolean> {
  const snapshot = await db
    .collection(FILES_COLLECTION)
    .where("userId", "==", userId)
    .where("contentHash", "==", contentHash)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * Process a single attachment
 */
async function processAttachment(
  attachment: Attachment,
  userId: string,
  inboundAddress: InboundEmailAddress,
  messageId: string,
  from: string,
  fromName: string | undefined,
  subject: string,
  receivedAt: Timestamp
): Promise<string | null> {
  // Check if attachment is supported (by MIME type or extension)
  const { supported, mimeType } = isSupportedAttachment(
    attachment.contentType,
    attachment.filename
  );

  if (!supported) {
    console.log(
      `[receiveEmail] Skipping unsupported type: ${attachment.contentType} (filename: ${attachment.filename})`
    );
    return null;
  }

  console.log(`[receiveEmail] Processing attachment: ${attachment.filename}, type: ${mimeType}, size: ${attachment.content?.length || 0} bytes`);

  // Skip oversized attachments
  if (attachment.size && attachment.size > MAX_ATTACHMENT_SIZE) {
    console.log(`[receiveEmail] Skipping oversized attachment: ${attachment.size} bytes`);
    return null;
  }

  // Get attachment content
  const buffer = attachment.content;
  if (!buffer || buffer.length === 0) {
    console.log("[receiveEmail] Skipping empty attachment");
    return null;
  }

  // Calculate content hash
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

  // Check for duplicate
  if (await fileExistsByHash(userId, contentHash)) {
    console.log(`[receiveEmail] Skipping duplicate file: ${contentHash}`);
    return null;
  }

  // Upload to storage - use inferred MIME type
  const filename = attachment.filename || `attachment_${Date.now()}.pdf`;
  const { storagePath, downloadUrl } = await uploadToStorage(
    userId,
    filename,
    buffer,
    mimeType
  );

  // Create file document - use inferred mimeType, not original contentType
  const fileId = await createFileDocument({
    userId,
    fileName: filename,
    fileType: mimeType,
    fileSize: buffer.length,
    storagePath,
    downloadUrl,
    contentHash,
    sourceType: "email_inbound",
    inboundEmailId: inboundAddress.id,
    inboundEmailAddress: inboundAddress.email,
    inboundMessageId: messageId,
    inboundFrom: from,
    inboundFromName: fromName,
    inboundSubject: subject,
    inboundReceivedAt: receivedAt,
  });

  console.log(`[receiveEmail] Created file: ${fileId} from attachment: ${filename}`);

  return fileId;
}

/**
 * Convert email body to PDF and save as file
 */
async function processEmailBody(
  html: string | undefined,
  text: string | undefined,
  userId: string,
  inboundAddress: InboundEmailAddress,
  messageId: string,
  from: string,
  fromName: string | undefined,
  subject: string,
  date: Date | undefined,
  receivedAt: Timestamp
): Promise<string | null> {
  const content = html || text;
  if (!content || content.trim().length === 0) {
    console.log("[receiveEmail] No email body to convert");
    return null;
  }

  // Convert to PDF
  const pdfResult = await convertHtmlToPdf(content, {
    subject,
    from,
    date,
  });

  // Calculate content hash
  const contentHash = crypto
    .createHash("sha256")
    .update(pdfResult.pdfBuffer)
    .digest("hex");

  // Check for duplicate
  if (await fileExistsByHash(userId, contentHash)) {
    console.log(`[receiveEmail] Skipping duplicate email body PDF: ${contentHash}`);
    return null;
  }

  // Generate filename
  const sanitizedSubject = (subject || "email")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 50);
  const filename = `${sanitizedSubject}_${Date.now()}.pdf`;

  // Upload to storage
  const { storagePath, downloadUrl } = await uploadToStorage(
    userId,
    filename,
    pdfResult.pdfBuffer,
    "application/pdf"
  );

  // Create file document
  const fileId = await createFileDocument({
    userId,
    fileName: filename,
    fileType: "application/pdf",
    fileSize: pdfResult.pdfBuffer.length,
    storagePath,
    downloadUrl,
    contentHash,
    sourceType: "email_inbound_body",
    inboundEmailId: inboundAddress.id,
    inboundEmailAddress: inboundAddress.email,
    inboundMessageId: messageId,
    inboundFrom: from,
    inboundFromName: fromName,
    inboundSubject: subject,
    inboundReceivedAt: receivedAt,
  });

  console.log(`[receiveEmail] Created file: ${fileId} from email body`);

  return fileId;
}

/**
 * Parsed fields from SendGrid when "Send Raw" is disabled
 */
interface SendGridParsedFields {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: string;
  envelope?: string;
  sender_ip?: string;
  SPF?: string;
  charsets?: string;
  attachmentCount?: string;
}

/**
 * Parse SendGrid webhook payload
 * Handles both raw email mode (email field) and parsed mode (individual fields)
 */
async function parseSendGridWebhook(
  req: { headers: Record<string, string | string[] | undefined>; rawBody?: Buffer; body?: Buffer }
): Promise<ParsedMail | null> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    console.log(`[receiveEmail] Content-Type: ${contentType}`);

    // If it's multipart form data (SendGrid's format)
    if (typeof contentType === "string" && contentType.includes("multipart/form-data")) {
      const busboy = Busboy({ headers: req.headers as Record<string, string> });
      let emailData: string | null = null;
      const parsedFields: SendGridParsedFields = {};
      const attachments: Array<{ filename: string; contentType: string; content: Buffer }> = [];

      busboy.on("field", (fieldname: string, val: string) => {
        console.log(`[receiveEmail] Field: ${fieldname} (${val.length} chars)`);
        // SendGrid sends the raw email in 'email' field when "Send Raw" is enabled
        if (fieldname === "email") {
          emailData = val;
        } else {
          // Store parsed fields for non-raw mode
          (parsedFields as Record<string, string>)[fieldname] = val;
        }
      });

      busboy.on("file", (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
        console.log(`[receiveEmail] File: ${fieldname}, filename: ${info.filename}, type: ${info.mimeType}`);
        const chunks: Buffer[] = [];
        file.on("data", (chunk: Buffer) => chunks.push(chunk));
        file.on("end", () => {
          attachments.push({
            filename: info.filename,
            contentType: info.mimeType,
            content: Buffer.concat(chunks),
          });
        });
      });

      busboy.on("finish", async () => {
        console.log(`[receiveEmail] Busboy finish. Raw email: ${!!emailData}, Fields: ${Object.keys(parsedFields).join(", ")}, Attachments: ${attachments.length}`);

        if (emailData) {
          // Raw mode - parse the complete email
          try {
            const parsed = await simpleParser(emailData);
            resolve(parsed);
          } catch (err) {
            console.error("[receiveEmail] Failed to parse raw email:", err);
            reject(err);
          }
        } else if (parsedFields.from || parsedFields.to) {
          // Parsed mode - construct a ParsedMail-like object from fields
          console.log("[receiveEmail] Using parsed fields mode");
          console.log(`[receiveEmail] Raw 'to' field: "${parsedFields.to}"`);

          // Parse the 'from' field - extract email and name from "Name <email>" format
          let fromAddress = parsedFields.from?.trim();
          let fromName: string | undefined;
          if (fromAddress) {
            const angleMatch = fromAddress.match(/^(.+?)\s*<([^>]+)>$/);
            if (angleMatch) {
              fromName = angleMatch[1].replace(/^["']|["']$/g, "").trim();
              fromAddress = angleMatch[2];
            }
          }

          // Parse the 'to' field - extract email from "Name <email>" format or use as-is
          let toAddress = parsedFields.to?.trim();
          if (toAddress) {
            // If it's in "Name <email>" format, extract just the email
            const angleMatch = toAddress.match(/<([^>]+)>/);
            if (angleMatch) {
              toAddress = angleMatch[1];
            }
          }
          console.log(`[receiveEmail] Parsed toAddress: "${toAddress}"`);

          // Create a ParsedMail-compatible object
          const parsed: ParsedMail = {
            from: fromAddress ? {
              value: [{ address: fromAddress, name: fromName || "" }],
              text: parsedFields.from || "",
              html: "",
            } : undefined,
            to: toAddress ? {
              value: [{ address: toAddress, name: "" }],
              text: parsedFields.to || "",
              html: "",
            } : undefined,
            subject: parsedFields.subject,
            text: parsedFields.text,
            html: parsedFields.html || false,
            date: new Date(),
            messageId: `sendgrid-${Date.now()}`,
            attachments: attachments.map((att, i) => ({
              filename: att.filename,
              contentType: att.contentType,
              content: att.content,
              size: att.content.length,
              contentDisposition: "attachment" as const,
              type: att.contentType,
              partId: String(i),
              release: () => {},
              related: false,
              headers: new Map(),
              headerLines: [],
              checksum: "",
            })) as Attachment[],
            headers: new Map(),
            headerLines: [],
          };

          resolve(parsed);
        } else {
          console.log("[receiveEmail] No email data or parsed fields found");
          resolve(null);
        }
      });

      busboy.on("error", (err) => {
        console.error("[receiveEmail] Busboy error:", err);
        reject(err);
      });

      // Write the raw body to busboy
      const body = req.rawBody || req.body;
      if (body) {
        console.log(`[receiveEmail] Processing body: ${body.length} bytes`);
        busboy.end(body);
      } else {
        reject(new Error("No request body"));
      }
    } else {
      // Raw email format (not multipart)
      console.log("[receiveEmail] Non-multipart content type");
      const body = req.rawBody || req.body;
      if (body) {
        simpleParser(body)
          .then(resolve)
          .catch((err) => {
            console.error("[receiveEmail] Failed to parse non-multipart email:", err);
            reject(err);
          });
      } else {
        resolve(null);
      }
    }
  });
}

/**
 * Extract address values from ParsedMail.to field
 */
function getToAddresses(to: AddressObject | AddressObject[] | undefined): Array<{ address?: string }> {
  if (!to) return [];
  if (Array.isArray(to)) {
    return to.flatMap(addr => addr.value || []);
  }
  return to.value || [];
}

// ============================================================================
// Test Endpoint for Local Development
// ============================================================================

interface TestEmailPayload {
  to: string; // e.g., "invoices-abc123@fibuki.com"
  from: string;
  fromName?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: string; // base64 encoded
  }>;
}

/**
 * Test endpoint for local development
 * Allows simulating inbound emails without SendGrid
 *
 * Usage:
 * curl -X POST http://localhost:5001/PROJECT_ID/europe-west1/testInboundEmail \
 *   -H "Content-Type: application/json" \
 *   -d '{"to":"invoices-PREFIX@fibuki.com","from":"test@example.com","subject":"Test Invoice","html":"<h1>Test</h1>"}'
 */
export const testInboundEmail = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    // Only allow in emulator environment
    const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
    if (!isEmulator) {
      res.status(403).send("Test endpoint only available in emulator");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    console.log("[testInboundEmail] Received test email request");

    try {
      const payload = req.body as TestEmailPayload;

      if (!payload.to || !payload.from || !payload.subject) {
        res.status(400).json({
          error: "Missing required fields: to, from, subject",
        });
        return;
      }

      // Extract email prefix from 'to' address
      const emailPrefix = extractEmailPrefix(payload.to);
      if (!emailPrefix) {
        res.status(400).json({
          error: `Invalid recipient address format. Expected: invoices-PREFIX@${INBOUND_EMAIL_DOMAIN}`,
        });
        return;
      }

      // Look up the inbound address
      const inboundAddress = await lookupInboundAddress(emailPrefix);
      if (!inboundAddress) {
        res.status(404).json({
          error: `No active inbound address found for prefix: ${emailPrefix}`,
        });
        return;
      }

      console.log(
        `[testInboundEmail] Processing test email for user: ${inboundAddress.userId}`
      );

      const messageId = `test-${Date.now()}`;
      const from = payload.from;
      const fromName = payload.fromName;
      const subject = payload.subject;
      const receivedAt = Timestamp.now();

      // Validation checks
      let rejectionReason: string | null = null;

      if (!isWithinRateLimit(inboundAddress)) {
        rejectionReason = "rate_limit";
      }

      if (!rejectionReason && !isSenderAllowed(inboundAddress, from)) {
        rejectionReason = "domain_blocked";
      }

      if (rejectionReason) {
        await createLogEntry({
          userId: inboundAddress.userId,
          inboundAddressId: inboundAddress.id,
          messageId,
          from,
          fromName,
          subject,
          receivedAt,
          status: "rejected",
          filesCreated: [],
          attachmentsProcessed: 0,
          rejectionReason,
        });

        await updateAddressStats(inboundAddress.id, 0);

        res.status(200).json({
          success: false,
          rejected: true,
          reason: rejectionReason,
        });
        return;
      }

      const filesCreated: string[] = [];
      let attachmentsProcessed = 0;

      // Process test attachments (base64 encoded)
      if (payload.attachments && payload.attachments.length > 0) {
        for (const att of payload.attachments) {
          try {
            if (!SUPPORTED_MIME_TYPES.includes(att.contentType)) {
              console.log(`[testInboundEmail] Skipping unsupported type: ${att.contentType}`);
              continue;
            }

            const buffer = Buffer.from(att.content, "base64");
            const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

            if (await fileExistsByHash(inboundAddress.userId, contentHash)) {
              console.log(`[testInboundEmail] Skipping duplicate: ${contentHash}`);
              continue;
            }

            const { storagePath, downloadUrl } = await uploadToStorage(
              inboundAddress.userId,
              att.filename,
              buffer,
              att.contentType
            );

            const fileId = await createFileDocument({
              userId: inboundAddress.userId,
              fileName: att.filename,
              fileType: att.contentType,
              fileSize: buffer.length,
              storagePath,
              downloadUrl,
              contentHash,
              sourceType: "email_inbound",
              inboundEmailId: inboundAddress.id,
              inboundEmailAddress: inboundAddress.email,
              inboundMessageId: messageId,
              inboundFrom: from,
              inboundFromName: fromName,
              inboundSubject: subject,
              inboundReceivedAt: receivedAt,
            });

            filesCreated.push(fileId);
            attachmentsProcessed++;
          } catch (err) {
            console.error("[testInboundEmail] Error processing attachment:", err);
          }
        }
      }

      // Convert email body to PDF
      let bodyFileId: string | undefined;
      const htmlContent = payload.html;
      const textContent = payload.text;

      if (htmlContent || textContent) {
        try {
          const bodyId = await processEmailBody(
            htmlContent,
            textContent,
            inboundAddress.userId,
            inboundAddress,
            messageId,
            from,
            fromName,
            subject,
            new Date(),
            receivedAt
          );

          if (bodyId) {
            bodyFileId = bodyId;
            filesCreated.push(bodyId);
          }
        } catch (err) {
          console.error("[testInboundEmail] Error processing email body:", err);
        }
      }

      // Create log entry
      await createLogEntry({
        userId: inboundAddress.userId,
        inboundAddressId: inboundAddress.id,
        messageId,
        from,
        fromName,
        subject,
        receivedAt,
        status: "completed",
        filesCreated,
        bodyConvertedToFile: bodyFileId,
        attachmentsProcessed,
      });

      // Update stats
      await updateAddressStats(inboundAddress.id, filesCreated.length);

      console.log(
        `[testInboundEmail] Completed: ${filesCreated.length} files created`
      );

      res.status(200).json({
        success: true,
        filesCreated: filesCreated.length,
        fileIds: filesCreated,
        attachmentsProcessed,
        bodyConverted: !!bodyFileId,
      });
    } catch (error) {
      console.error("[testInboundEmail] Error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  }
);

// ============================================================================
// Main Cloud Function
// ============================================================================

/**
 * HTTP endpoint for receiving inbound emails via SendGrid webhook
 */
export const receiveInboundEmail = onRequest(
  {
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 120,
    maxInstances: 10,
  },
  async (req, res) => {
    console.log("[receiveEmail] Received inbound email webhook");

    // Only accept POST requests
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      // Parse the email
      const parsedEmail = await parseSendGridWebhook({
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody: req.rawBody,
        body: req.body,
      });

      if (!parsedEmail) {
        console.log("[receiveEmail] Failed to parse email");
        res.status(400).send("Invalid email format");
        return;
      }

      // Extract recipient address to find the inbound address
      const toAddresses = getToAddresses(parsedEmail.to);
      let emailPrefix: string | null = null;

      for (const addr of toAddresses) {
        if (addr.address) {
          emailPrefix = extractEmailPrefix(addr.address);
          if (emailPrefix) {
            break;
          }
        }
      }

      if (!emailPrefix) {
        console.log("[receiveEmail] No valid FiBuKI recipient found");
        res.status(404).send("Recipient not found");
        return;
      }

      // Look up the inbound address
      const inboundAddress = await lookupInboundAddress(emailPrefix);

      if (!inboundAddress) {
        console.log(`[receiveEmail] Unknown address prefix: ${emailPrefix}`);
        res.status(404).send("Recipient not found");
        return;
      }

      console.log(
        `[receiveEmail] Processing email for user: ${inboundAddress.userId}`
      );

      // Extract email metadata
      const messageId = parsedEmail.messageId || `inbound-${Date.now()}`;
      const fromAddr = parsedEmail.from?.value?.[0];
      const from = fromAddr?.address || "unknown@unknown.com";
      const fromName = fromAddr?.name;
      const subject = parsedEmail.subject || "(No Subject)";
      const emailDate = parsedEmail.date;
      const receivedAt = Timestamp.now();

      // Validation checks
      let rejectionReason: string | null = null;

      // Check rate limit
      if (!isWithinRateLimit(inboundAddress)) {
        rejectionReason = "rate_limit";
      }

      // Check sender domain
      if (!rejectionReason && !isSenderAllowed(inboundAddress, from)) {
        rejectionReason = "domain_blocked";
      }

      // Check for duplicate
      if (!rejectionReason && (await isDuplicate(inboundAddress.id, messageId))) {
        rejectionReason = "duplicate";
      }

      // If rejected, log and return
      if (rejectionReason) {
        console.log(`[receiveEmail] Rejected: ${rejectionReason}`);

        await createLogEntry({
          userId: inboundAddress.userId,
          inboundAddressId: inboundAddress.id,
          messageId,
          from,
          fromName,
          subject,
          receivedAt,
          status: "rejected",
          filesCreated: [],
          attachmentsProcessed: 0,
          rejectionReason,
        });

        // Update stats (count the rejected email)
        await updateAddressStats(inboundAddress.id, 0);

        // Return 200 to SendGrid so it doesn't retry
        res.status(200).send(`Rejected: ${rejectionReason}`);
        return;
      }

      // Process the email
      const filesCreated: string[] = [];

      // Process attachments
      const attachments = parsedEmail.attachments || [];
      let attachmentsProcessed = 0;

      for (const attachment of attachments) {
        try {
          const fileId = await processAttachment(
            attachment,
            inboundAddress.userId,
            inboundAddress,
            messageId,
            from,
            fromName,
            subject,
            receivedAt
          );

          if (fileId) {
            filesCreated.push(fileId);
            attachmentsProcessed++;
          }
        } catch (err) {
          console.error("[receiveEmail] Error processing attachment:", err);
        }
      }

      // Convert email body to PDF
      let bodyFileId: string | undefined;
      try {
        const htmlContent = typeof parsedEmail.html === "string" ? parsedEmail.html : undefined;
        const textContent = parsedEmail.text || undefined;

        const bodyId = await processEmailBody(
          htmlContent,
          textContent,
          inboundAddress.userId,
          inboundAddress,
          messageId,
          from,
          fromName,
          subject,
          emailDate,
          receivedAt
        );

        if (bodyId) {
          bodyFileId = bodyId;
          filesCreated.push(bodyId);
        }
      } catch (err) {
        console.error("[receiveEmail] Error processing email body:", err);
      }

      // Create log entry
      await createLogEntry({
        userId: inboundAddress.userId,
        inboundAddressId: inboundAddress.id,
        messageId,
        from,
        fromName,
        subject,
        receivedAt,
        status: "completed",
        filesCreated,
        bodyConvertedToFile: bodyFileId,
        attachmentsProcessed,
      });

      // Update stats
      await updateAddressStats(inboundAddress.id, filesCreated.length);

      console.log(
        `[receiveEmail] Completed: ${filesCreated.length} files created (${attachmentsProcessed} attachments, ${bodyFileId ? 1 : 0} body PDF)`
      );

      res.status(200).json({
        success: true,
        filesCreated: filesCreated.length,
        attachmentsProcessed,
        bodyConverted: !!bodyFileId,
      });
    } catch (error) {
      console.error("[receiveEmail] Error processing email:", error);
      res.status(500).send("Internal server error");
    }
  }
);
