import { onSchedule } from "firebase-functions/v2/scheduler";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";
import { encrypt, decrypt } from "../utils/encryption";
import { makeProvider, MailMessage, MailProvider } from "../mail";

// Define secrets for Google OAuth - set via Firebase CLI:
// firebase functions:secrets:set GOOGLE_CLIENT_ID
// firebase functions:secrets:set GOOGLE_CLIENT_SECRET
// firebase functions:secrets:set GMAIL_TOKEN_ENCRYPTION_KEY
const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const tokenEncryptionKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

const db = getFirestore();
const storage = getStorage();

// ============================================================================
// Constants
// ============================================================================

const PROCESSING_TIMEOUT_MS = 270000; // 4.5 minutes (leave buffer for 5 min function timeout)
const PAUSE_CHECK_INTERVAL = 5;

// ============================================================================
// Types
// ============================================================================

interface GmailSyncQueueItem {
  id: string;
  userId: string;
  integrationId: string;
  type: "initial" | "scheduled" | "manual";
  status: "pending" | "processing" | "completed" | "failed" | "paused";
  dateFrom: Timestamp;
  dateTo: Timestamp;
  nextPageToken?: string;
  emailsProcessed: number;
  filesCreated: number;
  attachmentsSkipped: number;
  errors: string[];
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  processedMessageIds: string[];
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

interface EmailTokenDocument {
  accessToken: string;
  refreshToken: string;
  refreshTokenIv?: string;
  expiresAt: Timestamp;
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return email.toLowerCase();
  return email.substring(atIndex + 1).toLowerCase();
}

async function sha256(data: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Decrypt refresh token if it was encrypted
 * Handles both encrypted (with IV) and legacy plaintext tokens
 */
function decryptRefreshToken(
  refreshToken: string,
  refreshTokenIv: string | undefined,
  encryptionKey: string
): string {
  // If no IV, token is not encrypted (legacy or encryption failed on store)
  if (!refreshTokenIv) {
    return refreshToken;
  }

  try {
    return decrypt(refreshToken, refreshTokenIv, encryptionKey);
  } catch (error) {
    console.error("[GmailSync] Failed to decrypt refresh token:", error);
    // Return as-is - might be a legacy plaintext token with corrupt IV field
    return refreshToken;
  }
}

/**
 * Refresh access token using refresh token
 * Returns new token data or null if refresh fails
 *
 * @param integrationId - The integration to refresh
 * @param refreshToken - The refresh token (possibly encrypted)
 * @param refreshTokenIv - The IV for decryption (if encrypted)
 * @param clientId - Google OAuth Client ID (from secret)
 * @param clientSecret - Google OAuth Client Secret (from secret)
 * @param encryptionKey - Key for token encryption/decryption
 */
async function refreshAccessToken(
  integrationId: string,
  refreshToken: string,
  refreshTokenIv: string | undefined,
  clientId: string,
  clientSecret: string,
  encryptionKey: string
): Promise<{ accessToken: string; expiresAt: Timestamp } | null> {
  if (!refreshToken) {
    console.log("[GmailSync] No refresh token available");
    return null;
  }

  if (!clientId || !clientSecret) {
    console.error("[GmailSync] Google OAuth credentials not configured in Cloud Functions");
    return null;
  }

  // Decrypt the refresh token
  const decryptedRefreshToken = decryptRefreshToken(refreshToken, refreshTokenIv, encryptionKey);

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: decryptedRefreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("[GmailSync] Token refresh failed:", errorData);
      return null;
    }

    const tokens = await response.json() as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

    // Reject downgraded scope grants — once OAuth verification lapses, Google
    // can issue refreshed tokens stripped of `gmail.readonly`. Flag for reauth
    // instead of silently using a useless token.
    const grantedScopes = new Set((tokens.scope || "").split(/\s+/).filter(Boolean));
    if (!grantedScopes.has("https://www.googleapis.com/auth/gmail.readonly")) {
      console.error(
        "[GmailSync] Refreshed token missing gmail.readonly. Granted:",
        tokens.scope,
      );
      await db.collection("emailIntegrations").doc(integrationId).update({
        needsReauth: true,
        lastError:
          "Gmail access not granted — please reconnect and grant 'View your email' permission.",
        updatedAt: Timestamp.now(),
      });
      return null;
    }

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + tokens.expires_in * 1000));

    // Re-encrypt the refresh token (use new one if provided, otherwise keep existing)
    const tokenToStore = tokens.refresh_token || decryptedRefreshToken;
    let encryptedRefreshToken = tokenToStore;
    let newRefreshTokenIv: string | undefined;

    if (encryptionKey) {
      try {
        const { encrypted, iv } = encrypt(tokenToStore, encryptionKey);
        encryptedRefreshToken = encrypted;
        newRefreshTokenIv = iv;
      } catch (encryptError) {
        console.error("[GmailSync] Failed to encrypt refresh token:", encryptError);
        // Store unencrypted as fallback
      }
    }

    // Update stored tokens (now encrypted)
    await db.collection("emailTokens").doc(integrationId).update({
      accessToken: tokens.access_token,
      refreshToken: encryptedRefreshToken,
      ...(newRefreshTokenIv && { refreshTokenIv: newRefreshTokenIv }),
      expiresAt,
      updatedAt: Timestamp.now(),
    });

    // Update integration
    await db.collection("emailIntegrations").doc(integrationId).update({
      tokenExpiresAt: expiresAt,
      needsReauth: false,
      lastError: null,
      updatedAt: Timestamp.now(),
    });

    return { accessToken: tokens.access_token, expiresAt };
  } catch (error) {
    console.error("[GmailSync] Token refresh error:", error);
    return null;
  }
}

// ============================================================================
// Queue Processor
// ============================================================================

interface ProcessQueueOptions {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
}

/**
 * Select and construct the MailProvider for a queue item, forking on the
 * integration's `provider`. Extracted verbatim from processQueueItem so the
 * two legs — the self-host IMAP path and the cloud Gmail/OAuth path — can be
 * covered in isolation (see gmailSyncQueue-provider-fork.test.ts).
 *
 * - imap: decrypt the stored app-password and hand the connection config to the
 *   provider. No OAuth, no refresh; the token doc carries no expiresAt.
 * - gmail/OAuth: refresh the access token if it is expired or expiring within
 *   five minutes; on refresh failure mark the integration needsReauth and throw.
 */
export async function resolveMailProvider(
  providerName: string,
  integrationData: FirebaseFirestore.DocumentData | undefined,
  tokenData: FirebaseFirestore.DocumentData,
  integrationId: string,
  options: ProcessQueueOptions
): Promise<MailProvider> {
  if (providerName === "imap") {
    // IMAP has one long-lived app-password (no refresh). Decrypt and hand the
    // connection config to the provider. Gmail's expiry/refresh dance below is
    // skipped entirely — the token doc has no expiresAt for IMAP.
    const t = tokenData as { secret?: string; secretIv?: string };
    if (!t.secret || !t.secretIv) {
      throw new Error("IMAP integration is missing its stored app-password");
    }
    const host = integrationData?.imapHost as string | undefined;
    const user = integrationData?.email as string | undefined;
    if (!host || !user) {
      throw new Error("IMAP integration is missing host or username");
    }
    const password = decrypt(t.secret, t.secretIv, options.encryptionKey);
    return makeProvider("imap", {
      imap: {
        host,
        port: (integrationData?.imapPort as number) ?? 993,
        secure: integrationData?.imapSecure !== false,
        allowSelfSigned: Boolean(integrationData?.imapAllowSelfSigned),
        mailbox: (integrationData?.imapMailbox as string) || "INBOX",
        keywordPrefilter: integrationData?.imapKeywordPrefilter !== false,
        user,
        password,
      },
    });
  }

  let token = tokenData as EmailTokenDocument;

  // Check if token is expired or about to expire (within 5 minutes)
  const tokenExpiresAt = token.expiresAt.toDate();
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt < fiveMinutesFromNow) {
    console.log(`[GmailSync] Token expired or expiring soon, attempting refresh...`);

    // Try to refresh the token using secrets
    const refreshedToken = await refreshAccessToken(
      integrationId,
      token.refreshToken,
      token.refreshTokenIv,
      options.clientId,
      options.clientSecret,
      options.encryptionKey
    );

    if (refreshedToken) {
      console.log(`[GmailSync] Token refreshed successfully`);
      token = { ...token, accessToken: refreshedToken.accessToken, expiresAt: refreshedToken.expiresAt };
    } else {
      // Refresh failed - mark integration as needing reauth
      await db.collection("emailIntegrations").doc(integrationId).update({
        needsReauth: true,
        lastError: "Access token expired and refresh failed",
        updatedAt: Timestamp.now(),
      });
      throw new Error("Access token expired and refresh failed - needs re-authentication");
    }
  }

  return makeProvider(providerName, { accessToken: token.accessToken });
}

async function processQueueItem(
  queueItem: GmailSyncQueueItem,
  options: ProcessQueueOptions
): Promise<void> {
  const startTime = Date.now();
  console.log(`[GmailSync] Processing queue item ${queueItem.id} (${queueItem.type})`);

  // Get integration email for storing on files
  const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
  const integrationData = integrationDoc.data();
  const integrationEmail = integrationDoc.exists ? (integrationData?.email as string) : undefined;
  const integrationPaused = Boolean(integrationData?.isPaused);

  const providerName = (integrationData?.provider as string) ?? "gmail";

  // Get stored credentials (Gmail OAuth tokens, or an IMAP app-password)
  const tokenDoc = await db.collection("emailTokens").doc(queueItem.integrationId).get();
  if (!tokenDoc.exists) {
    throw new Error("Email token not found");
  }

  const provider = await resolveMailProvider(
    providerName,
    integrationData,
    tokenDoc.data() as FirebaseFirestore.DocumentData,
    queueItem.integrationId,
    options
  );

  const dateFrom = queueItem.dateFrom.toDate();
  const dateTo = queueItem.dateTo.toDate();

  let emailsProcessed = queueItem.emailsProcessed;
  let filesCreated = queueItem.filesCreated;
  let attachmentsSkipped = queueItem.attachmentsSkipped;
  const errors: string[] = [...queueItem.errors];
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
      completedAt: Timestamp.now(),
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
    const searchResult = await provider.search({ dateFrom, dateTo, pageToken: nextPageToken });
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
        const message: MailMessage = await provider.getMessage({ id: messageId });
        emailsProcessed++;
        processedMessageIds.add(messageId);

        const attachments = message.attachments;
        if (attachments.length === 0) {
          continue;
        }

        // Extract email metadata
        const from = message.from;
        const subject = message.subject;
        const emailDate = message.date;

        // Parse sender email
        const emailMatch = from.match(/<([^>]+)>/) || [null, from];
        const senderEmail = emailMatch[1] || from;
        const senderDomain = extractEmailDomain(senderEmail);
        const senderName = from.split("<")[0].trim().replace(/"/g, "");

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
            const attachmentData = await provider.getAttachment(message, attachment);
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
            const downloadToken = (fileMetadata.metadata as Record<string, string>)?.firebaseStorageDownloadTokens
              || crypto.randomUUID();

            // If we generated a token, set it in the file metadata
            if (!(fileMetadata.metadata as Record<string, string>)?.firebaseStorageDownloadTokens) {
              await file.setMetadata({
                metadata: {
                  firebaseStorageDownloadTokens: downloadToken,
                },
              });
            }

            // Generate download URL with token (works for both emulator and production)
            const downloadUrl = buildDownloadUrl(bucket.name, storagePath, downloadToken);

            // Create file document
            const now = Timestamp.now();
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
              gmailEmailDate: Timestamp.fromDate(emailDate),

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
          } catch (attachError) {
            const errorMsg = `Failed to process attachment ${attachment.filename}: ${attachError}`;
            console.error(`[GmailSync] ${errorMsg}`);
            errors.push(errorMsg);
          }
        }
      } catch (messageError) {
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
      } else {
        // Delete old queue item and create new one to trigger onSyncQueueCreated
        // This chains function invocations, each with fresh 5-minute timeout
        const continuationData = {
          userId: queueItem.userId,
          integrationId: queueItem.integrationId,
          type: queueItem.type,
          status: "pending" as const,
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
          createdAt: Timestamp.now(),
        };

        // Delete old, create new (triggers onSyncQueueCreated)
        await db.collection("gmailSyncQueue").doc(queueItem.id).delete();
        await db.collection("gmailSyncQueue").add(continuationData);
        console.log(`[GmailSync] Created continuation (${emailsProcessed} emails processed, continuing...)`);
      }
    } else {
      // Mark as completed
      await db.collection("gmailSyncQueue").doc(queueItem.id).update({
        status: "completed",
        emailsProcessed,
        filesCreated,
        attachmentsSkipped,
        errors,
        nextPageToken: null,
        completedAt: Timestamp.now(),
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

      const completedAt = Timestamp.now();

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
      const durationSeconds = Math.round(
        (completedAt.toMillis() - startedAt.toMillis()) / 1000
      );

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
  } catch (error) {
    console.error(`[GmailSync] Error processing queue item:`, error);
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    // Detect Gmail "insufficient scopes" — happens when our OAuth verification
    // for `gmail.readonly` lapses or the user's grant doesn't include it. Flag
    // the integration so the UI prompts reconnect instead of silently failing.
    const isInsufficientScope =
      errorMsg.includes("insufficientPermissions") ||
      errorMsg.includes("Request had insufficient authentication scopes");
    if (isInsufficientScope) {
      await db.collection("emailIntegrations").doc(queueItem.integrationId).update({
        needsReauth: true,
        lastError:
          "Gmail access not granted — please reconnect and grant 'View your email' permission.",
        lastSyncError: errorMsg.slice(0, 1000),
        updatedAt: Timestamp.now(),
      });
    }

    // Check if this is a reauth error - pause instead of retry/fail
    // This allows auto-resume when Gmail is reconnected
    const isReauthError = isInsufficientScope ||
      errorMsg.includes("needs re-authentication") ||
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
      } else {
        // Initial/manual syncs: create new queue item for immediate retry
        const retryData = {
          userId: queueItem.userId,
          integrationId: queueItem.integrationId,
          type: queueItem.type,
          status: "pending" as const,
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
          createdAt: Timestamp.now(),
        };
        await db.collection("gmailSyncQueue").doc(queueItem.id).delete();
        await db.collection("gmailSyncQueue").add(retryData);
        console.log(`[GmailSync] Created retry queue item (attempt ${queueItem.retryCount + 1})`);
      }
    } else {
      const failedAt = Timestamp.now();
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
      const durationSeconds = Math.round(
        (failedAt.toMillis() - startedAt.toMillis()) / 1000
      );

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
  } finally {
    await provider.close();
  }
}

// ============================================================================
// Scheduled Queue Processor
// ============================================================================

/**
 * Process Gmail sync queue every 5 minutes.
 * Picks up pending queue items and processes them with rate limiting.
 */
export const processGmailSyncQueue = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [googleClientId, googleClientSecret, tokenEncryptionKey],
  },
  async () => {
    console.log("[GmailSync] Starting queue processor...");

    // Reset stale "processing" items (Cloud Function may have crashed/timed out)
    const staleThreshold = Timestamp.fromDate(new Date(Date.now() - 10 * 60 * 1000));
    const staleProcessing = await db
      .collection("gmailSyncQueue")
      .where("status", "==", "processing")
      .where("startedAt", "<", staleThreshold)
      .get();

    for (const doc of staleProcessing.docs) {
      console.log(`[GmailSync] Resetting stale processing item: ${doc.id}`);
      await doc.ref.update({ status: "pending", startedAt: null });
    }

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
    const queueItem = { id: queueDoc.id, ...queueDoc.data() } as GmailSyncQueueItem;
    const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
    const integrationPaused = Boolean(integrationDoc.data()?.isPaused);

    if (integrationPaused) {
      await queueDoc.ref.update({
        status: "paused",
        completedAt: Timestamp.now(),
      });
      console.log(`[GmailSync] Integration ${queueItem.integrationId} is paused, skipping queue item ${queueItem.id}`);
      return;
    }

    // Mark as processing
    await queueDoc.ref.update({
      status: "processing",
      startedAt: Timestamp.now(),
    });

    try {
      await processQueueItem(queueItem, {
        clientId: googleClientId.value(),
        clientSecret: googleClientSecret.value(),
        encryptionKey: tokenEncryptionKey.value(),
      });
    } catch (error) {
      console.error("[GmailSync] Queue processor error:", error);
    }
  }
);

// ============================================================================
// Immediate Trigger on Queue Creation
// ============================================================================

/**
 * Immediately start processing when a queue item is created.
 * This provides faster feedback for initial syncs.
 */
export const onSyncQueueCreated = onDocumentCreated(
  {
    document: "gmailSyncQueue/{queueId}",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [googleClientId, googleClientSecret, tokenEncryptionKey],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // Process initial and manual syncs immediately (scheduled syncs wait for the cron)
    if (data.type === "scheduled") {
      console.log("[GmailSync] Scheduled sync, will be processed by cron");
      return;
    }

    const queueItem = { id: event.params.queueId, ...data } as GmailSyncQueueItem;
    const integrationDoc = await db.collection("emailIntegrations").doc(queueItem.integrationId).get();
    const integrationPaused = Boolean(integrationDoc.data()?.isPaused);

    if (integrationPaused) {
      await event.data?.ref.update({
        status: "paused",
        completedAt: Timestamp.now(),
      });
      console.log(`[GmailSync] Integration ${queueItem.integrationId} is paused, skipping queue item ${queueItem.id}`);
      return;
    }

    // Mark as processing
    await event.data?.ref.update({
      status: "processing",
      startedAt: Timestamp.now(),
    });

    try {
      await processQueueItem(queueItem, {
        clientId: googleClientId.value(),
        clientSecret: googleClientSecret.value(),
        encryptionKey: tokenEncryptionKey.value(),
      });
    } catch (error) {
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
      } else {
        // Mark as failed
        await event.data?.ref.update({
          status: "failed",
          lastError: errorMessage,
          completedAt: Timestamp.now(),
        });
        console.log("[GmailSync] Max retries exceeded, marked as failed");
      }
    }
  }
);
