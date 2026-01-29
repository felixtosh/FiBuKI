"use strict";
/**
 * Inbound Email Webhook
 *
 * Receives emails forwarded to user's unique FiBuKI email address.
 * Processes attachments and converts email body to PDF.
 *
 * Designed for SendGrid Inbound Parse webhook.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.receiveInboundEmail = exports.testInboundEmail = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const crypto = __importStar(require("crypto"));
const busboy_1 = __importDefault(require("busboy"));
const mailparser_1 = require("mailparser");
const htmlToPdf_1 = require("../precision-search/htmlToPdf");
const db = (0, firestore_1.getFirestore)();
const storage = (0, storage_1.getStorage)();
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
/** Maximum attachment size (10MB) */
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Extract email prefix from recipient address
 * e.g., "invoices-abc123@taxstudio.app" -> "abc123"
 */
function extractEmailPrefix(email) {
    const match = email
        .toLowerCase()
        .match(new RegExp(`invoices-([a-z0-9_-]+)@${INBOUND_EMAIL_DOMAIN}`, "i"));
    return match ? match[1] : null;
}
/**
 * Extract domain from email address
 */
function extractDomain(email) {
    const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1] : null;
}
/**
 * Get today's date as YYYY-MM-DD
 */
function getTodayDate() {
    return new Date().toISOString().split("T")[0];
}
/**
 * Look up inbound address by email prefix
 */
async function lookupInboundAddress(emailPrefix) {
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
    return { id: doc.id, ...doc.data() };
}
/**
 * Check if sender domain is allowed
 */
function isSenderAllowed(address, senderEmail) {
    if (!address.allowedDomains || address.allowedDomains.length === 0) {
        return true;
    }
    const senderDomain = extractDomain(senderEmail);
    if (!senderDomain) {
        return false;
    }
    return address.allowedDomains.some((d) => d.toLowerCase() === senderDomain.toLowerCase());
}
/**
 * Check if within daily rate limit
 */
function isWithinRateLimit(address) {
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
async function isDuplicate(addressId, messageId) {
    const snapshot = await db
        .collection(INBOUND_LOGS_COLLECTION)
        .where("inboundAddressId", "==", addressId)
        .where("messageId", "==", messageId)
        .limit(1)
        .get();
    return !snapshot.empty;
}
/**
 * Create log entry
 */
async function createLogEntry(data) {
    const docRef = await db.collection(INBOUND_LOGS_COLLECTION).add({
        ...data,
        createdAt: firestore_1.Timestamp.now(),
    });
    return docRef.id;
}
/**
 * Update inbound address stats
 */
async function updateAddressStats(addressId, filesCreated) {
    const docRef = db.collection(INBOUND_ADDRESSES_COLLECTION).doc(addressId);
    const doc = await docRef.get();
    if (!doc.exists)
        return;
    const data = doc.data();
    const today = getTodayDate();
    await docRef.update({
        emailsReceived: (data.emailsReceived || 0) + 1,
        filesCreated: (data.filesCreated || 0) + filesCreated,
        lastEmailAt: firestore_1.Timestamp.now(),
        todayCount: data.todayDate === today ? data.todayCount + 1 : 1,
        todayDate: today,
        updatedAt: firestore_1.Timestamp.now(),
    });
}
/**
 * Sanitize filename for storage
 */
function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .substring(0, 100);
}
/**
 * Upload file to Firebase Storage
 */
async function uploadToStorage(userId, filename, buffer, contentType) {
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
    const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    return { storagePath, downloadUrl };
}
/**
 * Create file document in Firestore
 */
async function createFileDocument(data) {
    const now = firestore_1.Timestamp.now();
    const docRef = await db.collection(FILES_COLLECTION).add({
        ...data,
        extractionComplete: false,
        transactionIds: [],
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
    });
    return docRef.id;
}
/**
 * Check if file already exists (by content hash)
 */
async function fileExistsByHash(userId, contentHash) {
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
async function processAttachment(attachment, userId, inboundAddress, messageId, from, fromName, subject, receivedAt) {
    // Skip unsupported types
    if (!SUPPORTED_MIME_TYPES.includes(attachment.contentType || "")) {
        console.log(`[receiveEmail] Skipping unsupported type: ${attachment.contentType}`);
        return null;
    }
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
    // Upload to storage
    const filename = attachment.filename || `attachment_${Date.now()}.pdf`;
    const { storagePath, downloadUrl } = await uploadToStorage(userId, filename, buffer, attachment.contentType || "application/octet-stream");
    // Create file document
    const fileId = await createFileDocument({
        userId,
        fileName: filename,
        fileType: attachment.contentType || "application/octet-stream",
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
async function processEmailBody(html, text, userId, inboundAddress, messageId, from, fromName, subject, date, receivedAt) {
    const content = html || text;
    if (!content || content.trim().length === 0) {
        console.log("[receiveEmail] No email body to convert");
        return null;
    }
    // Convert to PDF
    const pdfResult = await (0, htmlToPdf_1.convertHtmlToPdf)(content, {
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
    const { storagePath, downloadUrl } = await uploadToStorage(userId, filename, pdfResult.pdfBuffer, "application/pdf");
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
 * Parse SendGrid webhook payload
 * SendGrid sends multipart/form-data with the email in 'email' field
 */
async function parseSendGridWebhook(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers["content-type"] || "";
        // If it's multipart form data (SendGrid's format)
        if (typeof contentType === "string" && contentType.includes("multipart/form-data")) {
            const busboy = (0, busboy_1.default)({ headers: req.headers });
            let emailData = null;
            busboy.on("field", (fieldname, val) => {
                // SendGrid sends the raw email in the 'email' field
                if (fieldname === "email") {
                    emailData = val;
                }
            });
            busboy.on("finish", async () => {
                if (emailData) {
                    try {
                        const parsed = await (0, mailparser_1.simpleParser)(emailData);
                        resolve(parsed);
                    }
                    catch (err) {
                        reject(err);
                    }
                }
                else {
                    resolve(null);
                }
            });
            busboy.on("error", reject);
            // Write the raw body to busboy
            const body = req.rawBody || req.body;
            if (body) {
                busboy.end(body);
            }
            else {
                reject(new Error("No request body"));
            }
        }
        else {
            // Raw email format
            const body = req.rawBody || req.body;
            if (body) {
                (0, mailparser_1.simpleParser)(body)
                    .then(resolve)
                    .catch(reject);
            }
            else {
                resolve(null);
            }
        }
    });
}
/**
 * Extract address values from ParsedMail.to field
 */
function getToAddresses(to) {
    if (!to)
        return [];
    if (Array.isArray(to)) {
        return to.flatMap(addr => addr.value || []);
    }
    return to.value || [];
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
exports.testInboundEmail = (0, https_1.onRequest)({
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 120,
}, async (req, res) => {
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
        const payload = req.body;
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
        console.log(`[testInboundEmail] Processing test email for user: ${inboundAddress.userId}`);
        const messageId = `test-${Date.now()}`;
        const from = payload.from;
        const fromName = payload.fromName;
        const subject = payload.subject;
        const receivedAt = firestore_1.Timestamp.now();
        // Validation checks
        let rejectionReason = null;
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
        const filesCreated = [];
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
                    const { storagePath, downloadUrl } = await uploadToStorage(inboundAddress.userId, att.filename, buffer, att.contentType);
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
                }
                catch (err) {
                    console.error("[testInboundEmail] Error processing attachment:", err);
                }
            }
        }
        // Convert email body to PDF
        let bodyFileId;
        const htmlContent = payload.html;
        const textContent = payload.text;
        if (htmlContent || textContent) {
            try {
                const bodyId = await processEmailBody(htmlContent, textContent, inboundAddress.userId, inboundAddress, messageId, from, fromName, subject, new Date(), receivedAt);
                if (bodyId) {
                    bodyFileId = bodyId;
                    filesCreated.push(bodyId);
                }
            }
            catch (err) {
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
        console.log(`[testInboundEmail] Completed: ${filesCreated.length} files created`);
        res.status(200).json({
            success: true,
            filesCreated: filesCreated.length,
            fileIds: filesCreated,
            attachmentsProcessed,
            bodyConverted: !!bodyFileId,
        });
    }
    catch (error) {
        console.error("[testInboundEmail] Error:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// ============================================================================
// Main Cloud Function
// ============================================================================
/**
 * HTTP endpoint for receiving inbound emails via SendGrid webhook
 */
exports.receiveInboundEmail = (0, https_1.onRequest)({
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 120,
    maxInstances: 10,
}, async (req, res) => {
    console.log("[receiveEmail] Received inbound email webhook");
    // Only accept POST requests
    if (req.method !== "POST") {
        res.status(405).send("Method not allowed");
        return;
    }
    try {
        // Parse the email
        const parsedEmail = await parseSendGridWebhook({
            headers: req.headers,
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
        let emailPrefix = null;
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
        console.log(`[receiveEmail] Processing email for user: ${inboundAddress.userId}`);
        // Extract email metadata
        const messageId = parsedEmail.messageId || `inbound-${Date.now()}`;
        const fromAddr = parsedEmail.from?.value?.[0];
        const from = fromAddr?.address || "unknown@unknown.com";
        const fromName = fromAddr?.name;
        const subject = parsedEmail.subject || "(No Subject)";
        const emailDate = parsedEmail.date;
        const receivedAt = firestore_1.Timestamp.now();
        // Validation checks
        let rejectionReason = null;
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
        const filesCreated = [];
        // Process attachments
        const attachments = parsedEmail.attachments || [];
        let attachmentsProcessed = 0;
        for (const attachment of attachments) {
            try {
                const fileId = await processAttachment(attachment, inboundAddress.userId, inboundAddress, messageId, from, fromName, subject, receivedAt);
                if (fileId) {
                    filesCreated.push(fileId);
                    attachmentsProcessed++;
                }
            }
            catch (err) {
                console.error("[receiveEmail] Error processing attachment:", err);
            }
        }
        // Convert email body to PDF
        let bodyFileId;
        try {
            const htmlContent = typeof parsedEmail.html === "string" ? parsedEmail.html : undefined;
            const textContent = parsedEmail.text || undefined;
            const bodyId = await processEmailBody(htmlContent, textContent, inboundAddress.userId, inboundAddress, messageId, from, fromName, subject, emailDate, receivedAt);
            if (bodyId) {
                bodyFileId = bodyId;
                filesCreated.push(bodyId);
            }
        }
        catch (err) {
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
        console.log(`[receiveEmail] Completed: ${filesCreated.length} files created (${attachmentsProcessed} attachments, ${bodyFileId ? 1 : 0} body PDF)`);
        res.status(200).json({
            success: true,
            filesCreated: filesCreated.length,
            attachmentsProcessed,
            bodyConverted: !!bodyFileId,
        });
    }
    catch (error) {
        console.error("[receiveEmail] Error processing email:", error);
        res.status(500).send("Internal server error");
    }
});
//# sourceMappingURL=receiveEmail.js.map