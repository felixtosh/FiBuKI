/**
 * Callable Cloud Function for mail search
 * Used by both UI (via callable) and can be imported by automation
 *
 * The request speaks the provider-neutral vocabulary of MailSearchTerms —
 * keywords, a sender, filenames, a date window (#240) — so the manual attach
 * path no longer has to know Gmail's query syntax to search a mailbox. A Gmail
 * integration compiles those terms into its query string here; every other
 * provider goes through the same factory Sync uses, and reports whatever it
 * could not execute instead of quietly dropping it.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { decrypt, encrypt } from "../utils/encryption";
import { classifyEmail, EmailClassification } from "../precision-search/shared-utils";
import {
  makeProvider,
  MailProvider,
  MailSearchLimitation,
  MailSearchTerms,
} from "../mail";
import { MAX_EMAILS_PER_BATCH } from "../mail/constants";
import { buildGmailQuery } from "../mail/gmail-query";
import { imapConfigFromIntegration } from "../mail/imap/config";

// Secrets for token refresh
const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const tokenEncryptionKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface SearchGmailRequest extends MailSearchTerms {
  integrationId: string;
  /**
   * Raw Gmail query.
   *
   * Not used by the attach path, which speaks the neutral terms this interface
   * inherits (#240). Kept for the Gmail-only automation callers — precision
   * search and the chat agent — which compose Gmail OR-queries of their own.
   * A provider that cannot execute it says so in `limitations`.
   */
  query?: string;
  dateFrom?: string; // ISO date
  dateTo?: string; // ISO date
  hasAttachments?: boolean;
  limit?: number;
  pageToken?: string;
  expandThreads?: boolean;
}

interface GmailAttachment {
  attachmentId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  isLikelyReceipt: boolean;
  existingFileId?: string | null;
}

interface GmailMessageResult {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string | null;
  date: string; // ISO string
  snippet: string;
  bodyText: string | null;
  attachments: GmailAttachment[];
  /** Email classification based on content analysis */
  classification?: EmailClassification;
}

interface SearchGmailResponse {
  messages: GmailMessageResult[];
  nextPageToken?: string;
  totalEstimate?: number;
  /**
   * Constraints the provider could not execute as asked. Absent when it could
   * — which is every Gmail search, since Gmail executes the whole vocabulary.
   */
  limitations?: MailSearchLimitation[];
}

export interface EmailTokenDocument {
  accessToken: string;
  refreshToken: string;
  refreshTokenIv?: string;
  expiresAt: Timestamp;
}

interface GmailApiMessage {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string;
  payload: GmailApiPart; // Root payload is also a part
}

interface GmailApiPart {
  partId?: string;
  mimeType?: string;
  filename?: string; // Optional - not all parts have filenames
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailApiPart[];
}

// ============================================================================
// Helper Functions
// ============================================================================

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

// Receipt/invoice keywords (multilingual)
const RECEIPT_KEYWORDS = [
  "invoice", "rechnung", "receipt", "beleg", "quittung",
  "faktura", "bon", "bill", "order", "confirmation",
  "payment", "bestellung", "bestätigung", "zahlung",
];

function isLikelyReceiptAttachment(filename: string, mimeType: string): boolean {
  const receiptMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  // Check MIME type first
  const normalizedMime = mimeType.toLowerCase();
  const isReceiptType = receiptMimeTypes.includes(normalizedMime) ||
    (normalizedMime === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf"));

  if (!isReceiptType) return false;

  // For PDFs, almost always likely receipts
  if (normalizedMime === "application/pdf" ||
      (normalizedMime === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf"))) {
    return true;
  }

  // For images, check filename for keywords
  const filenameLower = filename.toLowerCase();
  return RECEIPT_KEYWORDS.some((kw) => filenameLower.includes(kw));
}

/**
 * Compile one search into Gmail's `q`.
 *
 * The terms half is `buildGmailQuery`, shared with GmailProvider so a keyword
 * cannot mean one thing to Sync and another to the attach path. The raw `query`
 * from the automation callers is prepended untouched, and the date window keeps
 * this callable's own (unpadded, exclusive-`before:`) spelling.
 */
function buildGmailSearchQuery(params: {
  query?: string;
  keywords?: string[];
  from?: string;
  filenames?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  hasAttachments?: boolean;
}): string {
  const parts: string[] = [];

  if (params.query) {
    parts.push(params.query);
  }

  // `keywords ?? []` and not `keywords`: an omitted keyword list here means
  // "no keyword clause", never the invoice sweep buildGmailQuery falls back to
  // for the sync worker.
  const terms = buildGmailQuery({
    keywords: params.keywords ?? [],
    from: params.from,
    filenames: params.filenames ?? [],
    hasAttachment: params.hasAttachments === true,
  });
  if (terms) {
    parts.push(terms);
  }

  if (params.dateFrom) {
    const d = params.dateFrom;
    parts.push(`after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }

  if (params.dateTo) {
    const d = params.dateTo;
    parts.push(`before:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }

  return parts.join(" ");
}

function extractHeader(message: GmailApiMessage, name: string): string | null {
  const header = message.payload.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  );
  return header?.value || null;
}

function parseFromHeader(from: string | null): { email: string; name: string | null } {
  if (!from) return { email: "", name: null };

  // Parse "Name <email@example.com>" format
  const match = from.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
  if (match) {
    return {
      name: match[1]?.trim() || null,
      email: match[2]?.trim() || from,
    };
  }
  return { email: from, name: null };
}

/**
 * Recursively extract attachments from message payload.
 * Matches GmailClient logic exactly for consistent results.
 */
function extractAttachments(message: GmailApiMessage): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  function processPart(part: GmailApiPart | undefined) {
    if (!part) return;

    // Check if this part is an attachment (has filename AND attachmentId)
    if (part.filename && part.body?.attachmentId) {
      const mimeType = part.mimeType || "application/octet-stream";
      attachments.push({
        attachmentId: part.body.attachmentId,
        messageId: message.id, // Required for downloading attachment later
        filename: part.filename,
        mimeType,
        size: part.body.size || 0,
        isLikelyReceipt: isLikelyReceiptAttachment(part.filename, mimeType),
      });
    }

    // Recursively check child parts
    if (part.parts) {
      for (const childPart of part.parts) {
        processPart(childPart);
      }
    }
  }

  // Start from root payload (same as GmailClient)
  processPart(message.payload);

  return attachments;
}

function extractBodyText(message: GmailApiMessage): string | null {
  let textContent: string | null = null;

  function processPart(part: GmailApiPart) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      const decoded = Buffer.from(part.body.data, "base64").toString("utf-8");
      if (!textContent || decoded.length > textContent.length) {
        textContent = decoded;
      }
    }
    if (part.parts) {
      part.parts.forEach(processPart);
    }
  }

  if (message.payload.parts) {
    message.payload.parts.forEach(processPart);
  } else if (message.payload.body?.data) {
    textContent = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
  }

  return textContent;
}

async function gmailFetch<T>(
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${GMAIL_API_BASE}/users/me${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new HttpsError("unauthenticated", "Gmail authentication expired");
    }
    const errorText = await response.text();
    throw new HttpsError("internal", `Gmail API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ============================================================================
// Token Refresh Helper
// ============================================================================

async function tryRefreshToken(
  integrationId: string,
  tokens: EmailTokenDocument,
  integrationRef: FirebaseFirestore.DocumentReference
): Promise<{ accessToken: string; expiresAt: Timestamp } | null> {
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) return null;

  const clientId = googleClientId.value();
  const clientSecret = googleClientSecret.value();
  const encryptionKey = tokenEncryptionKey.value();

  if (!clientId || !clientSecret) {
    console.error("[searchGmailCallable] OAuth credentials not configured");
    return null;
  }

  // Decrypt refresh token if encrypted
  let decryptedRefreshToken = refreshToken;
  if (tokens.refreshTokenIv && encryptionKey) {
    try {
      decryptedRefreshToken = decrypt(refreshToken, tokens.refreshTokenIv, encryptionKey);
    } catch (err) {
      console.error("[searchGmailCallable] Failed to decrypt refresh token:", err);
      return null;
    }
  }

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
      console.error("[searchGmailCallable] Token refresh failed:", errorData);
      return null;
    }

    const result = await response.json() as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

    // Reject downgraded scope grants — without gmail.readonly the integration
    // cannot read messages, so flag for reauth rather than silently caching
    // a token that will only fail with 403 on every Gmail call.
    const grantedScopes = new Set((result.scope || "").split(/\s+/).filter(Boolean));
    if (!grantedScopes.has("https://www.googleapis.com/auth/gmail.readonly")) {
      console.error(
        "[searchGmailCallable] Refreshed token missing gmail.readonly. Granted:",
        result.scope,
      );
      await integrationRef.update({
        needsReauth: true,
        lastError:
          "Gmail access not granted — please reconnect and grant 'View your email' permission.",
        updatedAt: Timestamp.now(),
      });
      return null;
    }

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + result.expires_in * 1000));

    // Re-encrypt the refresh token for storage
    const tokenToStore = result.refresh_token || decryptedRefreshToken;
    let encryptedRefreshToken = tokenToStore;
    let newRefreshTokenIv: string | undefined;

    if (encryptionKey) {
      try {
        const { encrypted, iv } = encrypt(tokenToStore, encryptionKey);
        encryptedRefreshToken = encrypted;
        newRefreshTokenIv = iv;
      } catch {
        // Store unencrypted as fallback
      }
    }

    // Update stored tokens
    await db.collection("emailTokens").doc(integrationId).update({
      accessToken: result.access_token,
      refreshToken: encryptedRefreshToken,
      ...(newRefreshTokenIv && { refreshTokenIv: newRefreshTokenIv }),
      expiresAt,
      updatedAt: Timestamp.now(),
    });

    // Update integration metadata
    await integrationRef.update({
      tokenExpiresAt: expiresAt,
      needsReauth: false,
      lastError: null,
      updatedAt: Timestamp.now(),
    });

    console.log("[searchGmailCallable] Token refreshed successfully");
    return { accessToken: result.access_token, expiresAt };
  } catch (error) {
    console.error("[searchGmailCallable] Token refresh error:", error);
    return null;
  }
}

// ============================================================================
// Shared helpers (both provider legs)
// ============================================================================

/**
 * Files already imported from these messages, keyed `messageId:attachmentId`.
 *
 * The two stored fields still carry Gmail's names for every provider — an IMAP
 * File records its UID in `gmailMessageId` and its BODYSTRUCTURE part id in
 * `gmailAttachmentId`, because the dedup index rides them. Renaming them is
 * #102's, not this ticket's.
 */
async function findExistingFiles(
  userId: string,
  messageIds: string[]
): Promise<Map<string, string>> {
  const existingFilesMap = new Map<string, string>();
  const ids = [...new Set(messageIds)];

  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30);
    const existingQuery = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("gmailMessageId", "in", batch)
      .get();

    for (const doc of existingQuery.docs) {
      const data = doc.data();
      if (data.gmailAttachmentId) {
        const key = `${data.gmailMessageId}:${data.gmailAttachmentId}`;
        existingFilesMap.set(key, doc.id);
      }
    }
  }

  return existingFilesMap;
}

/**
 * How far back a search with no date window reaches on a provider that needs
 * one. Gmail ranks an unbounded query and returns a page; IMAP would have to
 * walk the mailbox, so the window is closed here and the caller is told.
 */
const DEFAULT_MAIL_WINDOW_DAYS = 365;

/**
 * The non-Gmail leg: run the same neutral terms through the provider factory
 * that already serves Sync, and map its provider-neutral messages onto the
 * result shape the attach path consumes.
 *
 * What is thinner than the Gmail leg, deliberately: no snippet, no body text
 * and no thread expansion. Those are Gmail payload fields, and the tabs that
 * need them (mail-to-PDF) are #245's; an attachment carries everything the
 * attach path needs to file it.
 */
async function searchViaProvider(
  provider: MailProvider,
  params: {
    userId: string;
    terms: MailSearchTerms;
    dateFrom?: Date;
    dateTo?: Date;
    limit: number;
    pageToken?: string;
    rawQuery?: string;
    expandThreads?: boolean;
  }
): Promise<SearchGmailResponse> {
  const limitations: MailSearchLimitation[] = [];

  // The page is what bounds the work: everything the provider returns is then
  // fetched one message at a time. MAX_EMAILS_PER_BATCH is the size both
  // providers already page Sync at, and the attach path never asks for more —
  // the clamp is here so a caller cannot turn one request into a mailbox walk.
  const limit = Math.min(params.limit, MAX_EMAILS_PER_BATCH);

  const dateTo = params.dateTo ?? new Date();
  const dateFrom =
    params.dateFrom ??
    new Date(dateTo.getTime() - DEFAULT_MAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (!params.dateFrom) {
    limitations.push({
      constraint: "dateWindow",
      handling: "scanned",
      detail: `No date window was given; this provider cannot search a mailbox unbounded, so the last ${DEFAULT_MAIL_WINDOW_DAYS} days were searched.`,
    });
  }
  if (params.rawQuery) {
    limitations.push({
      constraint: "rawQuery",
      handling: "unsupported",
      detail:
        "A raw Gmail query means nothing to this provider and was not applied; the neutral terms were.",
    });
  }
  if (params.expandThreads) {
    limitations.push({
      constraint: "threads",
      handling: "unsupported",
      detail:
        "This provider has no threads, so results are single messages rather than expanded conversations.",
    });
  }

  try {
    const page = await provider.search({
      ...params.terms,
      dateFrom,
      dateTo,
      limit,
      pageToken: params.pageToken,
    });
    limitations.push(...(page.limitations ?? []));

    const fetched = await Promise.all(
      page.messages.map((ref) => provider.getMessage(ref))
    );
    // The attachment constraint is the provider's `scanned` limitation made
    // good: it could not narrow the search to attachment-bearing messages, so
    // the narrowing happens here, over the one bounded page it returned.
    const messages =
      params.terms.hasAttachment === false
        ? fetched
        : fetched.filter((m) => m.attachments.length > 0);

    const existingFilesMap = await findExistingFiles(
      params.userId,
      messages.map((m) => m.id)
    );

    const responseMessages: GmailMessageResult[] = messages.map((msg) => {
      const { email: fromEmail, name: fromName } = parseFromHeader(msg.from);
      const attachments: GmailAttachment[] = msg.attachments.map((att) => ({
        attachmentId: att.attachmentId,
        messageId: msg.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        isLikelyReceipt: isLikelyReceiptAttachment(att.filename, att.mimeType),
        existingFileId: existingFilesMap.get(`${msg.id}:${att.attachmentId}`) || null,
      }));

      return {
        messageId: msg.id,
        // No threads outside Gmail; the message stands in for its own thread.
        threadId: msg.id,
        subject: msg.subject || "(No Subject)",
        from: fromEmail,
        fromName,
        date: msg.date.toISOString(),
        snippet: "",
        bodyText: null,
        attachments,
        classification: classifyEmail(msg.subject || "", "", attachments, null),
      };
    });

    return {
      messages: responseMessages,
      nextPageToken: page.nextPageToken,
      totalEstimate: responseMessages.length,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  } finally {
    await provider.close();
  }
}

// ============================================================================
// Main Callable Function
// ============================================================================

/**
 * Search Gmail for messages with attachments
 * Returns enriched results with existing file IDs
 */
export const searchGmailCallable = onCall<
  SearchGmailRequest,
  Promise<SearchGmailResponse>
>(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [googleClientId, googleClientSecret, tokenEncryptionKey],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }

    const userId = request.auth.uid;
    const {
      integrationId,
      query,
      keywords,
      filenames,
      dateFrom,
      dateTo,
      from,
      hasAttachments = true,
      limit = 20,
      pageToken,
      expandThreads = false,
    } = request.data;

    if (!integrationId) {
      throw new HttpsError("invalid-argument", "integrationId is required");
    }

    console.log("[searchGmailCallable] Request", {
      userId,
      integrationId,
      query,
      keywords,
      filenames,
      dateFrom,
      dateTo,
      from,
      hasAttachments,
      limit,
      pageToken,
      expandThreads,
    });

    // Verify integration exists and belongs to user
    const integrationRef = db.collection("emailIntegrations").doc(integrationId);
    const integrationSnap = await integrationRef.get();

    if (!integrationSnap.exists) {
      throw new HttpsError("not-found", "Integration not found");
    }

    const integration = integrationSnap.data()!;
    if (integration.userId !== userId) {
      throw new HttpsError("permission-denied", "Integration not found");
    }

    if (integration.needsReauth) {
      throw new HttpsError("failed-precondition", "Re-authentication required");
    }

    // Get tokens
    const tokenRef = db.collection("emailTokens").doc(integrationId);
    const tokenSnap = await tokenRef.get();

    if (!tokenSnap.exists) {
      throw new HttpsError("failed-precondition", "Tokens not found. Please reconnect Gmail.");
    }

    // Everything but Gmail goes through the factory Sync already uses. The
    // OAuth refresh below is Gmail's alone — an IMAP token doc holds one
    // app-password and no expiresAt to read.
    const providerName = (integration.provider as string) || "gmail";
    if (providerName !== "gmail") {
      if (providerName !== "imap") {
        throw new HttpsError(
          "failed-precondition",
          `Mail provider "${providerName}" cannot be searched`
        );
      }

      const provider = makeProvider("imap", {
        imap: imapConfigFromIntegration(
          integration,
          tokenSnap.data() as { secret?: string; secretIv?: string },
          tokenEncryptionKey.value()
        ),
      });

      const response = await searchViaProvider(provider, {
        userId,
        // `?? []` on both lists, for the same reason the Gmail leg does it: an
        // omitted list here means "the caller named no such term", never the
        // invoice sweep a provider falls back to for the Sync worker. The two
        // legs have to lower one request the same way or the neutral terms are
        // not neutral.
        terms: {
          keywords: keywords ?? [],
          from,
          filenames: filenames ?? [],
          hasAttachment: hasAttachments,
        },
        dateFrom: dateFrom ? new Date(dateFrom) : undefined,
        dateTo: dateTo ? new Date(dateTo) : undefined,
        limit,
        pageToken,
        rawQuery: query,
        expandThreads,
      });

      await integrationRef.update({
        lastAccessedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

      console.log("[searchGmailCallable] Response", {
        integrationId,
        provider: providerName,
        messageCount: response.messages.length,
        limitations: response.limitations?.map((l) => l.constraint),
      });

      return response;
    }

    let tokens = tokenSnap.data() as EmailTokenDocument;

    // If access token is expired, attempt to refresh it
    if (tokens.expiresAt.toDate() < new Date()) {
      console.log("[searchGmailCallable] Access token expired, attempting refresh...");

      const refreshed = await tryRefreshToken(
        integrationId,
        tokens,
        integrationRef
      );

      if (refreshed) {
        tokens = { ...tokens, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
      } else {
        await integrationRef.update({
          needsReauth: true,
          lastError: "Access token expired and refresh failed",
          updatedAt: Timestamp.now(),
        });
        throw new HttpsError("failed-precondition", "Access token expired. Please reconnect Gmail.");
      }
    }

    // Build search query
    const searchQuery = buildGmailSearchQuery({
      query,
      keywords,
      from,
      filenames,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      hasAttachments,
    });

    // Search for message IDs
    const searchParams = new URLSearchParams({
      q: searchQuery,
      maxResults: String(limit),
    });
    if (pageToken) {
      searchParams.set("pageToken", pageToken);
    }

    const searchResult = await gmailFetch<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(tokens.accessToken, `/messages?${searchParams.toString()}`);

    if (!searchResult.messages || searchResult.messages.length === 0) {
      return {
        messages: [],
        nextPageToken: undefined,
        totalEstimate: 0,
      };
    }

    // Fetch full message details
    let messages: GmailApiMessage[];

    if (expandThreads) {
      // Get unique thread IDs and fetch full threads
      const threadIds = [...new Set(searchResult.messages.map((m) => m.threadId))];
      const threadResults = await Promise.all(
        threadIds.map(async (threadId) => {
          const thread = await gmailFetch<{ messages: GmailApiMessage[] }>(
            tokens.accessToken,
            `/threads/${threadId}?format=full`
          );
          return thread.messages;
        })
      );
      messages = threadResults.flat();
    } else {
      messages = await Promise.all(
        searchResult.messages.map((msg) =>
          gmailFetch<GmailApiMessage>(tokens.accessToken, `/messages/${msg.id}?format=full`)
        )
      );
    }

    // Which of these attachments are already Files, keyed message:attachment
    const existingFilesMap = await findExistingFiles(
      userId,
      messages.filter((msg) => extractAttachments(msg).length > 0).map((msg) => msg.id)
    );

    // Transform messages to response format
    const responseMessages: GmailMessageResult[] = messages.map((msg) => {
      const fromHeader = extractHeader(msg, "From");
      const { email: fromEmail, name: fromName } = parseFromHeader(fromHeader);
      const attachments = extractAttachments(msg);
      const subject = extractHeader(msg, "Subject") || "(No Subject)";
      const snippet = msg.snippet || "";
      const bodyText = extractBodyText(msg);

      // Classify email to determine type (mail invoice, invoice link, has PDF)
      // Include bodyText for better classification of mail invoices
      const classification = classifyEmail(subject, snippet, attachments, bodyText);

      return {
        messageId: msg.id,
        threadId: msg.threadId,
        subject,
        from: fromEmail,
        fromName,
        date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
        snippet,
        bodyText,
        attachments: attachments.map((att) => {
          const key = `${msg.id}:${att.attachmentId}`;
          return {
            ...att,
            existingFileId: existingFilesMap.get(key) || null,
          };
        }),
        classification,
      };
    });

    // Update last accessed time
    await integrationRef.update({
      lastAccessedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    console.log("[searchGmailCallable] Response", {
      integrationId,
      messageCount: responseMessages.length,
      totalEstimate: searchResult.resultSizeEstimate,
      existingFilesFound: existingFilesMap.size,
    });

    return {
      messages: responseMessages,
      nextPageToken: searchResult.nextPageToken,
      totalEstimate: searchResult.resultSizeEstimate,
    };
  }
);

// ============================================================================
// Direct Search Function (for automation - same logic, no auth check)
// ============================================================================

export interface SearchGmailDirectParams {
  accessToken: string;
  query?: string;
  hasAttachments?: boolean;
  limit?: number;
}

/**
 * Direct Gmail search for use within Cloud Functions (automation).
 *
 * Shares the callable's query compilation (`buildGmailSearchQuery`), not its
 * whole path: the callable also forks on the integration's provider (#240) and
 * defaults `hasAttachments` to true, where automation callers here default it
 * to false and pass a raw Gmail `query` of their own. Gmail only.
 */
export async function searchGmailDirect(
  params: SearchGmailDirectParams
): Promise<GmailMessageResult[]> {
  const {
    accessToken,
    query,
    hasAttachments = false,
    limit = 20,
  } = params;

  // Build search query - same function as callable
  const searchQuery = buildGmailSearchQuery({
    query,
    hasAttachments,
  });

  // Search for message IDs
  const searchParams = new URLSearchParams({
    q: searchQuery,
    maxResults: String(limit),
  });

  const searchResult = await gmailFetch<{
    messages?: Array<{ id: string; threadId: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(accessToken, `/messages?${searchParams.toString()}`);

  if (!searchResult.messages || searchResult.messages.length === 0) {
    return [];
  }

  // Fetch full message details - same as callable
  const messages = await Promise.all(
    searchResult.messages.map((msg) =>
      gmailFetch<GmailApiMessage>(accessToken, `/messages/${msg.id}?format=full`)
    )
  );

  // Transform messages - same as callable
  return messages.map((msg) => {
    const fromHeader = extractHeader(msg, "From");
    const { email: fromEmail, name: fromName } = parseFromHeader(fromHeader);

    return {
      messageId: msg.id,
      threadId: msg.threadId,
      subject: extractHeader(msg, "Subject") || "(No Subject)",
      from: fromEmail,
      fromName,
      date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
      snippet: msg.snippet || "",
      bodyText: extractBodyText(msg),
      attachments: extractAttachments(msg),
    };
  });
}

// Re-export types and utilities for consumers
export type { GmailMessageResult, GmailAttachment };
export { buildGmailSearchQuery, isLikelyReceiptAttachment, tryRefreshToken };
