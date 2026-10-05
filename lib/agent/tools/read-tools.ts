/**
 * Read Tools
 *
 * Tools for fetching data without modifications. The reads with an MCP twin
 * (Transactions, Files, Partners, bank accounts, No-document Categories) are
 * wrappers over the shared tools in ./mcp-tools (#616); what stays here is
 * chat-only: queue status, Transaction history, extraction polling, and the
 * company and VAT lookups.
 */

import { toDateSafe } from "@/lib/utils";
import { fileDocumentAmount } from "@/lib/files/document-amount";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getFileTool,
  getPartnerTool,
  getSourceTool,
  getTransactionTool,
  listCategoriesTool,
  listFilesTool,
  listPartnersTool,
  listSourcesTool,
  listTransactionsTool,
} from "./mcp-tools";

// Lazy-load admin DB to avoid initialization at build time
let _db: ReturnType<typeof import("@/lib/firebase/admin").getAdminDb> | null = null;
async function getDb() {
  if (!_db) {
    const { getAdminDb } = await import("@/lib/firebase/admin");
    _db = getAdminDb();
  }
  return _db;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const maybeDate = (value as { toDate: () => unknown }).toDate();
    return maybeDate instanceof Date ? maybeDate : null;
  }
  return value instanceof Date ? value : null;
}

// #504: the stored document total, the same figure matching and the File view
// read. Values are coerced because the record comes through untyped.
function getEffectiveExtractedAmount(data: any): number | null {
  const lineItems: Array<{ amount?: unknown }> = Array.isArray(data?.extractedLineItems)
    ? data.extractedLineItems
    : [];
  return fileDocumentAmount({
    extractedAmount: toFiniteNumber(data?.extractedAmount),
    extractedLineItems: lineItems.map((item) => ({ amount: toFiniteNumber(item.amount) ?? 0 })),
    lineItemsUnreconciled: Boolean(data?.lineItemsUnreconciled),
  });
}

// ============================================================================
// Get Queue Status
// ============================================================================

export const getQueueStatusTool = tool(
  async (_, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    const [gmailSnapshot, precisionSnapshot, workerSnapshot, extractionSnapshot] = await Promise.all([
      db
        .collection("gmailSyncQueue")
        .where("userId", "==", userId)
        .limit(200)
        .get(),
      db
        .collection("precisionSearchQueue")
        .where("userId", "==", userId)
        .limit(200)
        .get(),
      db
        .collection(`users/${userId}/workerRequests`)
        .limit(200)
        .get(),
      db
        .collection("files")
        .where("userId", "==", userId)
        .limit(500)
        .get(),
    ]);

    let gmailPending = 0;
    let gmailProcessing = 0;
    let gmailEmailsProcessed = 0;
    let gmailFilesCreated = 0;
    let gmailAttachmentsSkipped = 0;
    let gmailOldestCreatedAt: Date | null = null;

    for (const doc of gmailSnapshot.docs) {
      const data = doc.data();
      if (data.status !== "pending" && data.status !== "processing") {
        continue;
      }
      if (data.status === "processing") gmailProcessing += 1;
      if (data.status === "pending") gmailPending += 1;
      gmailEmailsProcessed += data.emailsProcessed || 0;
      gmailFilesCreated += data.filesCreated || 0;
      gmailAttachmentsSkipped += data.attachmentsSkipped || 0;

      const createdAt = toDateOrNull(data.createdAt);
      if (createdAt && (!gmailOldestCreatedAt || createdAt < gmailOldestCreatedAt)) {
        gmailOldestCreatedAt = createdAt;
      }
    }

    let precisionPending = 0;
    let precisionProcessing = 0;
    let precisionTransactionsToProcess = 0;
    let precisionTransactionsProcessed = 0;
    let precisionTransactionsWithMatches = 0;
    let precisionFilesConnected = 0;

    for (const doc of precisionSnapshot.docs) {
      const data = doc.data();
      if (data.status !== "pending" && data.status !== "processing") {
        continue;
      }
      if (data.status === "processing") precisionProcessing += 1;
      if (data.status === "pending") precisionPending += 1;
      precisionTransactionsToProcess += data.transactionsToProcess || 0;
      precisionTransactionsProcessed += data.transactionsProcessed || 0;
      precisionTransactionsWithMatches += data.transactionsWithMatches || 0;
      precisionFilesConnected += data.totalFilesConnected || 0;
    }

    const precisionOutstandingTransactions = Math.max(
      0,
      precisionTransactionsToProcess - precisionTransactionsProcessed
    );

    const workerTypeStats = new Map<
      string,
      { total: number; pending: number; processing: number; running: number }
    >();
    let workerQueuedFileRefs = 0;
    let workerQueuedTransactionRefs = 0;

    for (const doc of workerSnapshot.docs) {
      const data = doc.data();
      if (data.status !== "pending" && data.status !== "processing" && data.status !== "running") {
        continue;
      }
      const workerType = typeof data.workerType === "string" ? data.workerType : "unknown";
      const status = typeof data.status === "string" ? data.status : "pending";
      const stats = workerTypeStats.get(workerType) || {
        total: 0,
        pending: 0,
        processing: 0,
        running: 0,
      };

      stats.total += 1;
      if (status === "pending") stats.pending += 1;
      if (status === "processing") stats.processing += 1;
      if (status === "running") stats.running += 1;
      workerTypeStats.set(workerType, stats);

      const triggerContext = (data.triggerContext || {}) as {
        fileId?: string;
        fileIds?: string[];
        transactionId?: string;
      };

      if (Array.isArray(triggerContext.fileIds) && triggerContext.fileIds.length > 0) {
        workerQueuedFileRefs += triggerContext.fileIds.length;
      } else if (typeof triggerContext.fileId === "string" && triggerContext.fileId.trim()) {
        workerQueuedFileRefs += 1;
      }

      if (typeof triggerContext.transactionId === "string" && triggerContext.transactionId.trim()) {
        workerQueuedTransactionRefs += 1;
      }
    }

    const filesAwaitingExtraction = extractionSnapshot.docs.filter((doc) => {
      const data = doc.data();
      return data.extractionComplete === false && !data.deletedAt && !data.extractionError;
    }).length;
    const gmailActiveItems = gmailPending + gmailProcessing;
    const precisionActiveItems = precisionPending + precisionProcessing;
    const workerActiveItems = Array.from(workerTypeStats.values()).reduce((sum, stats) => sum + stats.total, 0);
    const filesQueuedForProcessing = filesAwaitingExtraction + workerQueuedFileRefs;
    const transactionsQueuedForProcessing = precisionOutstandingTransactions + workerQueuedTransactionRefs;
    const activeQueueItems = gmailActiveItems + precisionActiveItems + workerActiveItems;
    const gmailImportRunning = gmailProcessing > 0;

    let loadLevel: "idle" | "moderate" | "high" = "idle";
    if (
      gmailImportRunning ||
      filesQueuedForProcessing >= 30 ||
      transactionsQueuedForProcessing >= 30 ||
      activeQueueItems >= 10
    ) {
      loadLevel = "high";
    } else if (
      activeQueueItems > 0 ||
      filesQueuedForProcessing > 0 ||
      transactionsQueuedForProcessing > 0
    ) {
      loadLevel = "moderate";
    }

    const workerByType = Array.from(workerTypeStats.entries())
      .map(([workerType, stats]) => ({ workerType, ...stats }))
      .sort((a, b) => b.total - a.total);

    const summaryParts: string[] = [];
    if (gmailImportRunning) {
      summaryParts.push("Gmail import is currently running");
    }
    if (filesQueuedForProcessing > 0) {
      summaryParts.push(`${filesQueuedForProcessing} file(s) are queued for processing`);
    }
    if (transactionsQueuedForProcessing > 0) {
      summaryParts.push(`${transactionsQueuedForProcessing} transaction(s) are queued for processing`);
    }

    return {
      checkedAt: new Date().toISOString(),
      loadLevel,
      isBusy: loadLevel === "high",
      summary: summaryParts.length > 0
        ? `${summaryParts.join(". ")}.`
        : "All processing queues are currently idle.",
      gmailSync: {
        activeItems: gmailActiveItems,
        pending: gmailPending,
        processing: gmailProcessing,
        gmailImportRunning,
        emailsProcessed: gmailEmailsProcessed,
        filesCreated: gmailFilesCreated,
        attachmentsSkipped: gmailAttachmentsSkipped,
        oldestCreatedAt: gmailOldestCreatedAt ? gmailOldestCreatedAt.toISOString() : null,
      },
      fileProcessing: {
        filesAwaitingExtraction,
        workerQueueFileRefs: workerQueuedFileRefs,
        totalFilesQueued: filesQueuedForProcessing,
      },
      transactionProcessing: {
        precisionQueueItems: precisionActiveItems,
        precisionPending,
        precisionProcessing,
        precisionTransactionsToProcess,
        precisionTransactionsProcessed,
        precisionOutstandingTransactions,
        precisionTransactionsWithMatches,
        precisionFilesConnected,
        workerQueueTransactionRefs: workerQueuedTransactionRefs,
        totalTransactionsQueued: transactionsQueuedForProcessing,
      },
      workerQueue: {
        activeItems: workerActiveItems,
        byWorkerType: workerByType,
      },
    };
  },
  {
    name: "getQueueStatus",
    description: `Get live queue/load status for background processing.

Use this before large matching actions to set expectations:
- Is a Gmail import currently running?
- How many files are queued for processing?
- How many transactions are queued for processing?

Returns aggregated queue counts across gmailSyncQueue, precisionSearchQueue,
workerRequests, and files awaiting extraction.`,
    schema: z.object({}),
  }
);

// ============================================================================
// Get Transaction History
// ============================================================================

export const getTransactionHistoryTool = tool(
  async ({ transactionId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Verify transaction ownership
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
      return { error: "Transaction not found" };
    }

    const historySnapshot = await db
      .collection("transactions")
      .doc(transactionId)
      .collection("history")
      .orderBy("changedAt", "desc")
      .limit(10)
      .get();

    const history = historySnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        changedAt: toDateSafe(data.changedAt)?.toISOString(),
        changedBy: data.changedBy,
        previousValues: data.previousValues,
        newValues: data.newValues,
      };
    });

    return {
      history,
      historyCount: history.length,
    };
  },
  {
    name: "getTransactionHistory",
    description: "Get the edit history for a transaction (shows previous changes)",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID"),
    }),
  }
);

// ============================================================================
// Wait For File Extraction
// ============================================================================

export const waitForFileExtractionTool = tool(
  async ({ fileId, timeoutSeconds = 30 }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    const pollIntervalMs = 2000; // Check every 2 seconds
    const maxAttempts = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs);
    let attempts = 0;

    console.log(`[waitForFileExtraction] Waiting for file ${fileId} extraction (timeout: ${timeoutSeconds}s)`);

    while (attempts < maxAttempts) {
      const doc = await db.collection("files").doc(fileId).get();

      if (!doc.exists) {
        return { error: `File ${fileId} not found` };
      }

      const data = doc.data()!;

      if (data.userId !== userId) {
        return { error: "Not authorized to access this file" };
      }

      // Check if extraction is complete
      if (data.extractionComplete) {
        // Get dates
        const extractedDate = toDateSafe(data.extractedDate);
        const uploadedAt = toDateSafe(data.uploadedAt);

        // The document total in integer cents, unsigned, as getFile (MCP's
        // get_file) reports it: invoiceDirection says money in or out (#616).
        const amountCents = getEffectiveExtractedAmount(data);

        console.log(`[waitForFileExtraction] Extraction complete for ${fileId}`);

        return {
          success: true,
          fileId: doc.id,
          extractionComplete: true,
          // Extracted data
          fileName: data.fileName,
          extractedPartner: data.extractedPartner || null,
          extractedAmount: amountCents,
          extractedAmountFormatted: amountCents != null
            ? new Intl.NumberFormat("de-DE", {
                style: "currency",
                currency: data.extractedCurrency || "EUR",
              }).format(amountCents / 100)
            : null,
          extractedCurrency: data.extractedCurrency || "EUR",
          extractedDate: extractedDate?.toISOString() || null,
          extractedDateFormatted: extractedDate?.toLocaleDateString("de-DE") || null,
          extractedVatId: data.extractedVatId || null,
          extractedIban: data.extractedIban || null,
          extractedInvoiceNumber: data.extractedInvoiceNumber || null,
          invoiceDirection: data.invoiceDirection || null,
          isNotInvoice: data.isNotInvoice || false,
          // Partner suggestions from extraction
          partnerSuggestions: data.partnerSuggestions || [],
          // Transaction suggestions from matching
          transactionSuggestions: data.transactionSuggestions || [],
          // Metadata
          uploadedAt: uploadedAt?.toISOString() || null,
          waitedSeconds: attempts * (pollIntervalMs / 1000),
        };
      }

      // Check for extraction error
      if (data.extractionError) {
        console.log(`[waitForFileExtraction] Extraction failed for ${fileId}: ${data.extractionError}`);
        return {
          success: false,
          fileId: doc.id,
          extractionComplete: false,
          error: data.extractionError,
          message: `Extraction failed: ${data.extractionError}`,
        };
      }

      // Wait before next poll
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    // Timeout reached
    console.log(`[waitForFileExtraction] Timeout waiting for ${fileId}`);
    return {
      success: false,
      fileId,
      extractionComplete: false,
      error: "timeout",
      message: `Extraction not complete after ${timeoutSeconds} seconds. File may still be processing.`,
      waitedSeconds: timeoutSeconds,
    };
  },
  {
    name: "waitForFileExtraction",
    description: `Wait for a file's AI extraction to complete and return the extracted data.

Use this AFTER downloading a Gmail attachment to:
1. Wait for extraction to finish (polls every 2s)
2. Get the extracted partner, amount, date, VAT ID, IBAN
3. Verify the file matches the expected transaction

Returns extracted data including:
- extractedPartner: Company name from the document
- extractedAmount: Document total in integer cents, unsigned (invoiceDirection says money in or out)
- extractedDate: Invoice date
- extractedVatId, extractedIban: Tax/bank identifiers
- partnerSuggestions: Auto-matched partner suggestions
- transactionSuggestions: Auto-matched transaction suggestions

Use this to verify a downloaded file is the right one before connecting.`,
    schema: z.object({
      fileId: z.string().describe("The file ID to wait for"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait (default 30, max 60)"),
    }),
  }
);

// ============================================================================
// Company Lookup Tool (AI-powered, read-only)
// ============================================================================

import { lookupCompany, lookupByVatId } from "@/lib/api/firebase-callable";

export const lookupCompanyInfoTool = tool(
  async ({ nameOrUrl }, config) => {
    const authHeader = config?.configurable?.authHeader;

    const searchTerm = nameOrUrl.trim();
    const isUrl = searchTerm.includes(".") && !searchTerm.includes(" ");

    console.log(`[lookupCompanyInfo] Looking up: ${searchTerm} (isUrl: ${isUrl})`);

    try {
      const companyInfo = isUrl
        ? await lookupCompany({ url: searchTerm }, authHeader)
        : await lookupCompany({ name: searchTerm }, authHeader);

      console.log(`[lookupCompanyInfo] Result:`, companyInfo);

      return {
        success: true,
        searchTerm,
        name: companyInfo.name || null,
        aliases: companyInfo.aliases || [],
        vatId: companyInfo.vatId || null,
        website: companyInfo.website || null,
        country: companyInfo.country || null,
        address: companyInfo.address || null,
        message: companyInfo.name
          ? `Found company info for "${companyInfo.name}"`
          : `No company info found for "${searchTerm}"`,
      };
    } catch (error) {
      console.error(`[lookupCompanyInfo] Failed:`, error);
      return {
        success: false,
        searchTerm,
        error: error instanceof Error ? error.message : "Lookup failed",
        message: `Could not look up "${searchTerm}"`,
      };
    }
  },
  {
    name: "lookupCompanyInfo",
    description: `Look up company information using AI-powered web search.

Use this to find company details like official name, VAT ID, website, and country.
This is a READ-ONLY lookup - it does NOT create any partner.

Use when you have a company name or website and need to:
- Verify the official company name
- Find their VAT ID for VIES validation
- Get their official website
- Determine their country

After getting results, you can use validateVatId to verify the VAT, then createPartner to create it.`,
    schema: z.object({
      nameOrUrl: z
        .string()
        .describe("Company name (e.g., 'Arac GmbH') or website URL (e.g., 'arac.de')"),
    }),
  }
);

// ============================================================================
// VAT ID Validation Tool (VIES, read-only)
// ============================================================================

export const validateVatIdTool = tool(
  async ({ vatId }, config) => {
    const authHeader = config?.configurable?.authHeader;

    const normalizedVat = vatId.trim().toUpperCase().replace(/\s/g, "");
    console.log(`[validateVatId] Validating: ${normalizedVat}`);

    try {
      const result = await lookupByVatId(normalizedVat, authHeader);
      console.log(`[validateVatId] Result:`, result);

      return {
        success: true,
        vatId: normalizedVat,
        isValid: result.viesValid ?? false,
        name: result.name || null,
        address: result.address || null,
        country: result.country || null,
        error: result.viesError || null,
        message: result.viesValid
          ? `VAT ${normalizedVat} is VALID - registered to "${result.name}"`
          : `VAT ${normalizedVat} is INVALID: ${result.viesError || "Not found in VIES"}`,
      };
    } catch (error) {
      console.error(`[validateVatId] Failed:`, error);
      return {
        success: false,
        vatId: normalizedVat,
        isValid: false,
        error: error instanceof Error ? error.message : "Validation failed",
        message: `Could not validate VAT ${normalizedVat}`,
      };
    }
  },
  {
    name: "validateVatId",
    description: `Validate a VAT ID using the official EU VIES service.

Use this to verify if a VAT ID is valid and get the registered company info.
This is a READ-ONLY validation - it does NOT create any partner.

Returns:
- isValid: true/false
- name: Official company name from VIES
- address: Registered address
- country: Country code

Use BEFORE creating a partner to verify the VAT is legitimate.`,
    schema: z.object({
      vatId: z.string().describe("VAT ID to validate (e.g., 'DE123456789', 'ATU12345678')"),
    }),
  }
);

// ============================================================================
// Export all read tools
// ============================================================================

export const READ_TOOLS = [
  listTransactionsTool,
  getTransactionTool,
  listSourcesTool,
  getSourceTool,
  getQueueStatusTool,
  getTransactionHistoryTool,
  listFilesTool,
  getFileTool,
  waitForFileExtractionTool,
  listPartnersTool,
  getPartnerTool,
  listCategoriesTool,
  lookupCompanyInfoTool,
  validateVatIdTool,
];
