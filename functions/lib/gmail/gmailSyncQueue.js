"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.onSyncQueueCreated = exports.processGmailSyncQueue = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-functions/v2/firestore");
const params_1 = require("firebase-functions/params");
const firestore_2 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const crypto = __importStar(require("crypto"));
// Define secrets for Google OAuth - set via Firebase CLI:
// firebase functions:secrets:set GOOGLE_CLIENT_ID
// firebase functions:secrets:set GOOGLE_CLIENT_SECRET
const googleClientId = (0, params_1.defineSecret)("GOOGLE_CLIENT_ID");
const googleClientSecret = (0, params_1.defineSecret)("GOOGLE_CLIENT_SECRET");
const db = (0, firestore_2.getFirestore)();
const storage = (0, storage_1.getStorage)();
// ============================================================================
// Constants
// ============================================================================
const MAX_EMAILS_PER_BATCH = 50;
const PROCESSING_TIMEOUT_MS = 270000; // 4.5 minutes (leave buffer for 5 min function timeout)
const REQUEST_DELAY_MS = 200; // 1000 / GMAIL_REQUESTS_PER_SECOND
const PAUSE_CHECK_INTERVAL = 5;
// Invoice search keywords
const INVOICE_KEYWORDS = [
    // German
    "Rechnung",
    "Beleg",
    "Quittung",
    "Faktura",
    "Zahlungsbeleg",
    "Kaufbeleg",
    "Zahlungsbestätigung",
    // English
    "Invoice",
    "Receipt",
    "Bill",
    "Payment confirmation",
    "Order confirmation",
];
// MIME types for invoices
const INVOICE_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
];
// ============================================================================
// Helper Functions
// ============================================================================
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatGmailDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
}
function buildInvoiceSearchQuery(dateFrom, dateTo) {
    const keywordQuery = `(${INVOICE_KEYWORDS.map((k) => `"${k}"`).join(" OR ")})`;
    const nextDay = new Date(dateTo);
    nextDay.setDate(nextDay.getDate() + 1);
    return `${keywordQuery} has:attachment filename:pdf after:${formatGmailDate(dateFrom)} before:${formatGmailDate(nextDay)}`;
}
function extractEmailDomain(email) {
    const atIndex = email.lastIndexOf("@");
    if (atIndex === -1)
        return email.toLowerCase();
    return email.substring(atIndex + 1).toLowerCase();
}
function extractHeader(message, headerName) {
    const header = message.payload.headers.find((h) => h.name.toLowerCase() === headerName.toLowerCase());
    return header?.value || null;
}
function extractAttachments(message) {
    const attachments = [];
    function processPartsRecursively(parts) {
        if (!parts)
            return;
        for (const part of parts) {
            // Check if this part is an invoice-type attachment
            if (part.body?.attachmentId &&
                part.filename &&
                INVOICE_MIME_TYPES.includes(part.mimeType)) {
                attachments.push({
                    attachmentId: part.body.attachmentId,
                    filename: part.filename,
                    mimeType: part.mimeType,
                    size: part.body.size || 0,
                });
            }
            // Recurse into nested parts
            if (part.parts) {
                processPartsRecursively(part.parts);
            }
        }
    }
    processPartsRecursively(message.payload.parts);
    return attachments;
}
async function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/**
 * Refresh access token using refresh token
 * Returns new token data or null if refresh fails
 *
 * @param integrationId - The integration to refresh
 * @param refreshToken - The refresh token
 * @param clientId - Google OAuth Client ID (from secret)
 * @param clientSecret - Google OAuth Client Secret (from secret)
 */
async function refreshAccessToken(integrationId, refreshToken, clientId, clientSecret) {
    if (!refreshToken) {
        console.log("[GmailSync] No refresh token available");
        return null;
    }
    if (!clientId || !clientSecret) {
        console.error("[GmailSync] Google OAuth credentials not configured in Cloud Functions");
        return null;
    }
    try {
        const response = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }),
        });
        if (!response.ok) {
            const errorData = await response.text();
            console.error("[GmailSync] Token refresh failed:", errorData);
            return null;
        }
        const tokens = await response.json();
        const expiresAt = firestore_2.Timestamp.fromDate(new Date(Date.now() + tokens.expires_in * 1000));
        // Update stored tokens
        await db.collection("emailTokens").doc(integrationId).update({
            accessToken: tokens.access_token,
            expiresAt,
            updatedAt: firestore_2.Timestamp.now(),
        });
        // Update integration
        await db.collection("emailIntegrations").doc(integrationId).update({
            tokenExpiresAt: expiresAt,
            needsReauth: false,
            lastError: null,
            updatedAt: firestore_2.Timestamp.now(),
        });
        return { accessToken: tokens.access_token, expiresAt };
    }
    catch (error) {
        console.error("[GmailSync] Token refresh error:", error);
        return null;
    }
}
// ============================================================================
// Gmail API Client
// ============================================================================
class GmailApiClient {
    constructor(accessToken) {
        this.lastRequestTime = 0;
        this.accessToken = accessToken;
    }
    async waitForRateLimit() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < REQUEST_DELAY_MS) {
            await sleep(REQUEST_DELAY_MS - elapsed + Math.random() * 50);
        }
        this.lastRequestTime = Date.now();
    }
    async searchMessages(query, pageToken) {
        await this.waitForRateLimit();
        const params = new URLSearchParams({
            q: query,
            maxResults: String(MAX_EMAILS_PER_BATCH),
        });
        if (pageToken) {
            params.set("pageToken", pageToken);
        }
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });
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
    async getMessage(messageId) {
        await this.waitForRateLimit();
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        if (!response.ok) {
            throw new Error(`Gmail get message failed: ${response.status}`);
        }
        return response.json();
    }
    async getAttachment(messageId, attachmentId) {
        await this.waitForRateLimit();
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        if (!response.ok) {
            throw new Error(`Gmail get attachment failed: ${response.status}`);
        }
        const data = await response.json();
        // Gmail returns base64url-encoded data
        const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
        return Buffer.from(base64, "base64");
    }
}
async function processQueueItem(queueItem, options) {
    const startTime = Date.now();
    console.log(`[GmailSync] Processing queue item ${queueItem.id} (${queueItem.type})`);
    // Get integration email for storing on files
    const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
    const integrationData = integrationDoc.data();
    const integrationEmail = integrationDoc.exists ? integrationData?.email : undefined;
    const integrationPaused = Boolean(integrationData?.isPaused);
    // Get access token
    const tokenDoc = await db.collection("emailTokens").doc(queueItem.integrationId).get();
    if (!tokenDoc.exists) {
        throw new Error("Email token not found");
    }
    let tokenData = tokenDoc.data();
    // Check if token is expired or about to expire (within 5 minutes)
    const tokenExpiresAt = tokenData.expiresAt.toDate();
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (tokenExpiresAt < fiveMinutesFromNow) {
        console.log(`[GmailSync] Token expired or expiring soon, attempting refresh...`);
        // Try to refresh the token using secrets
        const refreshedToken = await refreshAccessToken(queueItem.integrationId, tokenData.refreshToken, options.clientId, options.clientSecret);
        if (refreshedToken) {
            console.log(`[GmailSync] Token refreshed successfully`);
            tokenData = { ...tokenData, accessToken: refreshedToken.accessToken, expiresAt: refreshedToken.expiresAt };
        }
        else {
            // Refresh failed - mark integration as needing reauth
            await db.collection("emailIntegrations").doc(queueItem.integrationId).update({
                needsReauth: true,
                lastError: "Access token expired and refresh failed",
                updatedAt: firestore_2.Timestamp.now(),
            });
            throw new Error("Access token expired and refresh failed - needs re-authentication");
        }
    }
    const client = new GmailApiClient(tokenData.accessToken);
    const dateFrom = queueItem.dateFrom.toDate();
    const dateTo = queueItem.dateTo.toDate();
    const query = buildInvoiceSearchQuery(dateFrom, dateTo);
    console.log(`[GmailSync] Search query: ${query}`);
    let emailsProcessed = queueItem.emailsProcessed;
    let filesCreated = queueItem.filesCreated;
    let attachmentsSkipped = queueItem.attachmentsSkipped;
    const errors = [...queueItem.errors];
    let nextPageToken = queueItem.nextPageToken;
    let processedAttachments = 0;
    let timedOut = false;
    const processedMessageIds = new Set(queueItem.processedMessageIds || []);
    const markPausedAndExit = async () => {
        await db.collection("gmailSyncQueue").doc(queueItem.id).update({
            status: "paused",
            emailsProcessed,
            filesCreated,
            attachmentsSkipped,
            errors,
            nextPageToken: nextPageToken || null,
            processedMessageIds: Array.from(processedMessageIds),
            completedAt: firestore_2.Timestamp.now(),
        });
        console.log(`[GmailSync] Paused queue item ${queueItem.id}`);
    };
    const isPauseRequested = async () => {
        const [queueSnap, latestIntegrationSnap] = await Promise.all([
            db.collection("gmailSyncQueue").doc(queueItem.id).get(),
            db.collection("emailIntegrations").doc(queueItem.integrationId).get(),
        ]);
        const queueStatus = queueSnap.exists ? queueSnap.data()?.status : null;
        const latestIntegrationPaused = latestIntegrationSnap.exists
            ? Boolean(latestIntegrationSnap.data()?.isPaused)
            : false;
        return queueStatus === "paused" || latestIntegrationPaused;
    };
    try {
        if (integrationPaused || await isPauseRequested()) {
            await markPausedAndExit();
            return;
        }
        // Search for messages
        const searchResult = await client.searchMessages(query, nextPageToken);
        const messageIds = searchResult.messages;
        nextPageToken = searchResult.nextPageToken;
        console.log(`[GmailSync] Found ${messageIds.length} messages, nextPageToken: ${nextPageToken ? "yes" : "no"}`);
        let pauseChecks = 0;
        for (const { id: messageId } of messageIds) {
            // Skip already processed messages (from previous runs)
            if (processedMessageIds.has(messageId)) {
                continue;
            }
            pauseChecks++;
            if (pauseChecks >= PAUSE_CHECK_INTERVAL) {
                pauseChecks = 0;
                if (await isPauseRequested()) {
                    await markPausedAndExit();
                    return;
                }
            }
            // Check timeout - this is the only batch limiter now
            if (Date.now() - startTime > PROCESSING_TIMEOUT_MS) {
                console.log("[GmailSync] Approaching timeout, saving progress");
                timedOut = true;
                break;
            }
            try {
                const message = await client.getMessage(messageId);
                emailsProcessed++;
                processedMessageIds.add(messageId);
                const attachments = extractAttachments(message);
                if (attachments.length === 0) {
                    continue;
                }
                // Extract email metadata
                const from = extractHeader(message, "From") || "";
                const subject = extractHeader(message, "Subject") || "";
                const emailDate = new Date(parseInt(message.internalDate, 10));
                // Parse sender email
                const emailMatch = from.match(/<([^>]+)>/) || [null, from];
                const senderEmail = emailMatch[1] || from;
                const senderDomain = extractEmailDomain(senderEmail);
                const senderName = from.replace(/<[^>]+>/, "").trim().replace(/"/g, "");
                for (const attachment of attachments) {
                    // Check deduplication (including soft-deleted files to prevent re-import)
                    const existingFile = await db
                        .collection("files")
                        .where("userId", "==", queueItem.userId)
                        .where("gmailMessageId", "==", messageId)
                        .where("gmailAttachmentId", "==", attachment.attachmentId)
                        .limit(1)
                        .get();
                    if (!existingFile.empty) {
                        // File exists (either active or soft-deleted) - skip import
                        attachmentsSkipped++;
                        continue;
                    }
                    try {
                        // Download attachment
                        const attachmentData = await client.getAttachment(messageId, attachment.attachmentId);
                        const contentHash = await sha256(attachmentData);
                        // Check content hash deduplication
                        const hashDuplicate = await db
                            .collection("files")
                            .where("userId", "==", queueItem.userId)
                            .where("contentHash", "==", contentHash)
                            .limit(1)
                            .get();
                        if (!hashDuplicate.empty) {
                            attachmentsSkipped++;
                            continue;
                        }
                        // Upload to Firebase Storage
                        const timestamp = Date.now();
                        const sanitizedFilename = attachment.filename.replace(/[^a-zA-Z0-9.-]/g, "_");
                        const storagePath = `files/${queueItem.userId}/${timestamp}_${sanitizedFilename}`;
                        const bucket = storage.bucket();
                        const file = bucket.file(storagePath);
                        await file.save(attachmentData, {
                            metadata: {
                                contentType: attachment.mimeType,
                                contentDisposition: "inline",
                                metadata: {
                                    originalFilename: attachment.filename,
                                    gmailMessageId: messageId,
                                    gmailIntegrationId: queueItem.integrationId,
                                },
                            },
                        });
                        // Get the auto-generated download token from storage
                        // The emulator stores it in metadata.metadata.firebaseStorageDownloadTokens
                        // But we can also generate our own if not present
                        const [fileMetadata] = await file.getMetadata();
                        const downloadToken = fileMetadata.metadata?.firebaseStorageDownloadTokens
                            || crypto.randomUUID();
                        // If we generated a token, set it in the file metadata
                        if (!fileMetadata.metadata?.firebaseStorageDownloadTokens) {
                            await file.setMetadata({
                                metadata: {
                                    firebaseStorageDownloadTokens: downloadToken,
                                },
                            });
                        }
                        // Generate download URL with token (works for both emulator and production)
                        let downloadUrl;
                        const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
                        const encodedPath = encodeURIComponent(storagePath);
                        if (storageEmulatorHost) {
                            // Emulator URL format with token for inline preview
                            downloadUrl = `http://${storageEmulatorHost}/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
                        }
                        else {
                            // Production: use token-based URL
                            downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
                        }
                        // Create file document
                        const now = firestore_2.Timestamp.now();
                        await db.collection("files").add({
                            userId: queueItem.userId,
                            fileName: attachment.filename,
                            fileType: attachment.mimeType,
                            fileSize: attachment.size,
                            storagePath,
                            downloadUrl,
                            contentHash,
                            // Gmail source tracking
                            sourceType: "gmail",
                            gmailMessageId: messageId,
                            gmailIntegrationId: queueItem.integrationId,
                            gmailIntegrationEmail: integrationEmail,
                            gmailSubject: subject,
                            gmailAttachmentId: attachment.attachmentId,
                            gmailSenderEmail: senderEmail,
                            gmailSenderDomain: senderDomain,
                            gmailSenderName: senderName,
                            gmailEmailDate: firestore_2.Timestamp.fromDate(emailDate),
                            // Extraction (will be filled by extractFileData trigger)
                            extractionComplete: false,
                            // Relationships
                            transactionIds: [],
                            // Timestamps
                            uploadedAt: now,
                            createdAt: now,
                            updatedAt: now,
                        });
                        filesCreated++;
                        processedAttachments++;
                        console.log(`[GmailSync] Created file: ${attachment.filename} from ${senderEmail}`);
                    }
                    catch (attachError) {
                        const errorMsg = `Failed to process attachment ${attachment.filename}: ${attachError}`;
                        console.error(`[GmailSync] ${errorMsg}`);
                        errors.push(errorMsg);
                    }
                }
            }
            catch (messageError) {
                const errorMsg = `Failed to process message ${messageId}: ${messageError}`;
                console.error(`[GmailSync] ${errorMsg}`);
                errors.push(errorMsg);
            }
        }
        if (await isPauseRequested()) {
            await markPausedAndExit();
            return;
        }
        // Determine if we need to continue processing
        // Continue if there are more pages OR if we timed out before finishing current batch
        const hasMoreMessages = Boolean(nextPageToken) || timedOut;
        if (hasMoreMessages) {
            // For scheduled syncs, just update and let cron handle continuation
            // For initial/manual syncs, create a NEW queue item to trigger immediate continuation
            if (queueItem.type === "scheduled") {
                await db.collection("gmailSyncQueue").doc(queueItem.id).update({
                    status: "pending",
                    startedAt: null,
                    nextPageToken: nextPageToken || null,
                    emailsProcessed,
                    filesCreated,
                    attachmentsSkipped,
                    errors,
                    processedMessageIds: Array.from(processedMessageIds),
                });
                console.log(`[GmailSync] Saved progress (${emailsProcessed} emails), cron will continue`);
            }
            else {
                // Delete old queue item and create new one to trigger onSyncQueueCreated
                // This chains function invocations, each with fresh 5-minute timeout
                const continuationData = {
                    userId: queueItem.userId,
                    integrationId: queueItem.integrationId,
                    type: queueItem.type,
                    status: "pending",
                    dateFrom: queueItem.dateFrom,
                    dateTo: queueItem.dateTo,
                    nextPageToken: nextPageToken || null,
                    emailsProcessed,
                    filesCreated,
                    attachmentsSkipped,
                    errors,
                    retryCount: 0,
                    maxRetries: queueItem.maxRetries,
                    processedMessageIds: Array.from(processedMessageIds),
                    createdAt: firestore_2.Timestamp.now(),
                };
                // Delete old, create new (triggers onSyncQueueCreated)
                await db.collection("gmailSyncQueue").doc(queueItem.id).delete();
                await db.collection("gmailSyncQueue").add(continuationData);
                console.log(`[GmailSync] Created continuation (${emailsProcessed} emails processed, continuing...)`);
            }
        }
        else {
            // Mark as completed
            await db.collection("gmailSyncQueue").doc(queueItem.id).update({
                status: "completed",
                emailsProcessed,
                filesCreated,
                attachmentsSkipped,
                errors,
                nextPageToken: null,
                completedAt: firestore_2.Timestamp.now(),
            });
            // Get current integration to read existing syncedDateRange
            const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
            const integrationData = integrationDoc.data();
            const existingSyncedRange = integrationData?.syncedDateRange;
            // Expand syncedDateRange to include this sync's date range
            const newSyncedRange = {
                from: existingSyncedRange?.from && existingSyncedRange.from.toMillis() < queueItem.dateFrom.toMillis()
                    ? existingSyncedRange.from
                    : queueItem.dateFrom,
                to: existingSyncedRange?.to && existingSyncedRange.to.toMillis() > queueItem.dateTo.toMillis()
                    ? existingSyncedRange.to
                    : queueItem.dateTo,
            };
            const completedAt = firestore_2.Timestamp.now();
            // Update integration status
            await db.collection("emailIntegrations").doc(queueItem.integrationId).update({
                lastSyncAt: completedAt,
                lastSyncStatus: errors.length > 0 ? "partial" : "success",
                lastSyncError: errors.length > 0 ? errors[0] : null,
                lastSyncFileCount: filesCreated,
                initialSyncComplete: true,
                syncedDateRange: newSyncedRange,
                updatedAt: completedAt,
            });
            // Save sync history record for UI display
            const startedAt = queueItem.startedAt || queueItem.createdAt;
            const durationSeconds = Math.round((completedAt.toMillis() - startedAt.toMillis()) / 1000);
            await db.collection("gmailSyncHistory").add({
                userId: queueItem.userId,
                integrationId: queueItem.integrationId,
                integrationEmail: integrationData?.email || "Unknown",
                type: queueItem.type,
                status: errors.length > 0 ? "partial" : "completed",
                dateFrom: queueItem.dateFrom,
                dateTo: queueItem.dateTo,
                emailsSearched: emailsProcessed,
                filesCreated,
                attachmentsSkipped,
                errors,
                startedAt,
                completedAt,
                durationSeconds,
            });
            console.log(`[GmailSync] Completed: ${filesCreated} files created, ${emailsProcessed} emails processed`);
            console.log(`[GmailSync] Synced date range: ${newSyncedRange.from.toDate().toISOString()} to ${newSyncedRange.to.toDate().toISOString()}`);
        }
    }
    catch (error) {
        console.error(`[GmailSync] Error processing queue item:`, error);
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        // Check if this is a reauth error - pause instead of retry/fail
        // This allows auto-resume when Gmail is reconnected
        const isReauthError = errorMsg.includes("needs re-authentication") ||
            errorMsg.includes("needsReauth") ||
            errorMsg.includes("token expired");
        if (isReauthError) {
            console.log(`[GmailSync] Pausing queue item due to reauth required: ${queueItem.id}`);
            await db.collection("gmailSyncQueue").doc(queueItem.id).update({
                status: "paused",
                lastError: "Gmail needs reconnection. Will resume automatically when reconnected.",
                emailsProcessed,
                filesCreated,
                attachmentsSkipped,
                errors,
                processedMessageIds: Array.from(processedMessageIds),
            });
            // Don't retry or fail - just pause and wait for reconnection
            return;
        }
        // Check if we should retry (for non-reauth errors)
        if (queueItem.retryCount < queueItem.maxRetries) {
            if (queueItem.type === "scheduled") {
                // Scheduled syncs: update and let cron retry
                await db.collection("gmailSyncQueue").doc(queueItem.id).update({
                    status: "pending",
                    retryCount: queueItem.retryCount + 1,
                    lastError: errorMsg,
                    emailsProcessed,
                    filesCreated,
                    attachmentsSkipped,
                    errors,
                    processedMessageIds: Array.from(processedMessageIds),
                });
            }
            else {
                // Initial/manual syncs: create new queue item for immediate retry
                const retryData = {
                    userId: queueItem.userId,
                    integrationId: queueItem.integrationId,
                    type: queueItem.type,
                    status: "pending",
                    dateFrom: queueItem.dateFrom,
                    dateTo: queueItem.dateTo,
                    nextPageToken: queueItem.nextPageToken || null,
                    emailsProcessed,
                    filesCreated,
                    attachmentsSkipped,
                    errors,
                    retryCount: queueItem.retryCount + 1,
                    maxRetries: queueItem.maxRetries,
                    lastError: errorMsg,
                    processedMessageIds: Array.from(processedMessageIds),
                    createdAt: firestore_2.Timestamp.now(),
                };
                await db.collection("gmailSyncQueue").doc(queueItem.id).delete();
                await db.collection("gmailSyncQueue").add(retryData);
                console.log(`[GmailSync] Created retry queue item (attempt ${queueItem.retryCount + 1})`);
            }
        }
        else {
            const failedAt = firestore_2.Timestamp.now();
            const errorMsg = error instanceof Error ? error.message : "Unknown error";
            await db.collection("gmailSyncQueue").doc(queueItem.id).update({
                status: "failed",
                lastError: errorMsg,
                emailsProcessed,
                filesCreated,
                attachmentsSkipped,
                errors,
                completedAt: failedAt,
            });
            // Update integration status
            await db.collection("emailIntegrations").doc(queueItem.integrationId).update({
                lastSyncAt: failedAt,
                lastSyncStatus: "failed",
                lastSyncError: errorMsg,
                updatedAt: failedAt,
            });
            // Get integration email for history
            const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
            const integrationData = integrationDoc.data();
            // Save failure to history
            const startedAt = queueItem.startedAt || queueItem.createdAt;
            const durationSeconds = Math.round((failedAt.toMillis() - startedAt.toMillis()) / 1000);
            await db.collection("gmailSyncHistory").add({
                userId: queueItem.userId,
                integrationId: queueItem.integrationId,
                integrationEmail: integrationData?.email || "Unknown",
                type: queueItem.type,
                status: "failed",
                dateFrom: queueItem.dateFrom,
                dateTo: queueItem.dateTo,
                emailsSearched: emailsProcessed,
                filesCreated,
                attachmentsSkipped,
                errors: [...errors, errorMsg],
                startedAt,
                completedAt: failedAt,
                durationSeconds,
            });
        }
    }
}
// ============================================================================
// Scheduled Queue Processor
// ============================================================================
/**
 * Process Gmail sync queue every 5 minutes.
 * Picks up pending queue items and processes them with rate limiting.
 */
exports.processGmailSyncQueue = (0, scheduler_1.onSchedule)({
    schedule: "*/5 * * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [googleClientId, googleClientSecret],
}, async () => {
    console.log("[GmailSync] Starting queue processor...");
    // Get oldest pending queue item
    const pendingSnapshot = await db
        .collection("gmailSyncQueue")
        .where("status", "==", "pending")
        .orderBy("createdAt", "asc")
        .limit(1)
        .get();
    if (pendingSnapshot.empty) {
        console.log("[GmailSync] No pending queue items");
        return;
    }
    const queueDoc = pendingSnapshot.docs[0];
    const queueItem = { id: queueDoc.id, ...queueDoc.data() };
    const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
    const integrationPaused = Boolean(integrationDoc.data()?.isPaused);
    if (integrationPaused) {
        await queueDoc.ref.update({
            status: "paused",
            completedAt: firestore_2.Timestamp.now(),
        });
        console.log(`[GmailSync] Integration ${queueItem.integrationId} is paused, skipping queue item ${queueItem.id}`);
        return;
    }
    // Mark as processing
    await queueDoc.ref.update({
        status: "processing",
        startedAt: firestore_2.Timestamp.now(),
    });
    try {
        await processQueueItem(queueItem, {
            clientId: googleClientId.value(),
            clientSecret: googleClientSecret.value(),
        });
    }
    catch (error) {
        console.error("[GmailSync] Queue processor error:", error);
    }
});
// ============================================================================
// Immediate Trigger on Queue Creation
// ============================================================================
/**
 * Immediately start processing when a queue item is created.
 * This provides faster feedback for initial syncs.
 */
exports.onSyncQueueCreated = (0, firestore_1.onDocumentCreated)({
    document: "gmailSyncQueue/{queueId}",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [googleClientId, googleClientSecret],
}, async (event) => {
    const data = event.data?.data();
    if (!data)
        return;
    // Process initial and manual syncs immediately (scheduled syncs wait for the cron)
    if (data.type === "scheduled") {
        console.log("[GmailSync] Scheduled sync, will be processed by cron");
        return;
    }
    const queueItem = { id: event.params.queueId, ...data };
    const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
    const integrationPaused = Boolean(integrationDoc.data()?.isPaused);
    if (integrationPaused) {
        await event.data?.ref.update({
            status: "paused",
            completedAt: firestore_2.Timestamp.now(),
        });
        console.log(`[GmailSync] Integration ${queueItem.integrationId} is paused, skipping queue item ${queueItem.id}`);
        return;
    }
    // Mark as processing
    await event.data?.ref.update({
        status: "processing",
        startedAt: firestore_2.Timestamp.now(),
    });
    try {
        await processQueueItem(queueItem, {
            clientId: googleClientId.value(),
            clientSecret: googleClientSecret.value(),
        });
    }
    catch (error) {
        console.error("[GmailSync] Immediate processing error:", error);
        // Update queue item with failure status
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const retryCount = queueItem.retryCount || 0;
        const maxRetries = queueItem.maxRetries || 3;
        if (retryCount < maxRetries) {
            // Mark for retry
            await event.data?.ref.update({
                status: "pending",
                retryCount: retryCount + 1,
                lastError: errorMessage,
            });
            console.log(`[GmailSync] Marked for retry (${retryCount + 1}/${maxRetries})`);
        }
        else {
            // Mark as failed
            await event.data?.ref.update({
                status: "failed",
                lastError: errorMessage,
                completedAt: firestore_2.Timestamp.now(),
            });
            console.log("[GmailSync] Max retries exceeded, marked as failed");
        }
    }
});
//# sourceMappingURL=gmailSyncQueue.js.map