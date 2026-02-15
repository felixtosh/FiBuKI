/**
 * Read Tools
 *
 * Tools for fetching data without modifications.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

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

function inferLineItemAmountsAreNet(
  lineItems: Array<{ amount?: unknown; vatAmount?: unknown; vatPercent?: unknown }>
): boolean {
  let comparedItems = 0;
  let netInterpretationError = 0;
  let grossInterpretationError = 0;

  for (const item of lineItems) {
    const amount = toFiniteNumber(item.amount);
    const vatAmount = toFiniteNumber(item.vatAmount);
    const vatPercent = toFiniteNumber(item.vatPercent);
    if (amount === null || vatAmount === null || vatPercent === null || vatPercent <= 0) {
      continue;
    }

    const expectedVatIfNet = Math.round((amount * vatPercent) / 100);
    const expectedVatIfGross = Math.round((amount * vatPercent) / (100 + vatPercent));

    netInterpretationError += Math.abs(expectedVatIfNet - vatAmount);
    grossInterpretationError += Math.abs(expectedVatIfGross - vatAmount);
    comparedItems += 1;
  }

  if (comparedItems === 0) {
    return false;
  }

  return netInterpretationError < grossInterpretationError;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getEffectiveExtractedAmount(data: any): number | null {
  const extractedAmount = toFiniteNumber(data?.extractedAmount);
  const lineItems = Array.isArray(data?.extractedLineItems)
    ? data.extractedLineItems as Array<{ amount?: unknown; vatAmount?: unknown; vatPercent?: unknown }>
    : [];

  if (lineItems.length === 0) {
    return extractedAmount;
  }

  const amountFromItems = lineItems.reduce((sum, item) => {
    const amount = toFiniteNumber(item.amount);
    return amount === null ? sum : sum + amount;
  }, 0);
  const vatFromItems = lineItems.reduce((sum, item) => {
    const vatAmount = toFiniteNumber(item.vatAmount);
    return vatAmount === null ? sum : sum + vatAmount;
  }, 0);

  const amountsLookNet = vatFromItems > 0 && inferLineItemAmountsAreNet(lineItems);
  if (amountsLookNet) {
    return amountFromItems + vatFromItems;
  }

  return extractedAmount ?? amountFromItems;
}

// ============================================================================
// List Transactions
// ============================================================================

export const listTransactionsTool = tool(
  async (
    {
      startDate,
      endDate,
      search,
      minAmount,
      maxAmount,
      sourceId,
      partnerId,
      categoryId,
      hasFile,
      limit = 20,
    },
    config
  ) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    let query = db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("date", "desc");

    if (sourceId) {
      query = query.where("sourceId", "==", sourceId);
    }

    if (partnerId) {
      query = query.where("partnerId", "==", partnerId);
    }

    if (categoryId) {
      query = query.where("categoryId", "==", categoryId);
    }

    if (hasFile !== undefined) {
      if (hasFile) {
        query = query.where("fileIds", "!=", []);
      }
    }

    // When using client-side filters (search, date, amount), fetch more transactions
    // This ensures filters find matches across all transactions
    const hasClientSideFilters = search || startDate || endDate || minAmount !== undefined || maxAmount !== undefined;
    const fetchLimit = hasClientSideFilters ? 500 : limit;
    const snapshot = await query.limit(fetchLimit).get();

    // Collect all fileIds to check for soft-deleted files
    const allFileIds = new Set<string>();
    snapshot.docs.forEach((doc) => {
      const fileIds = doc.data().fileIds || [];
      fileIds.forEach((id: string) => allFileIds.add(id));
    });

    // Fetch files to check which are soft-deleted
    const deletedFileIds = new Set<string>();
    if (allFileIds.size > 0) {
      const fileChunks = [];
      const fileIdArray = Array.from(allFileIds);
      for (let i = 0; i < fileIdArray.length; i += 10) {
        fileChunks.push(fileIdArray.slice(i, i + 10));
      }
      for (const chunk of fileChunks) {
        const filesSnapshot = await db
          .collection("files")
          .where("__name__", "in", chunk)
          .get();
        filesSnapshot.docs.forEach((fileDoc) => {
          if (fileDoc.data().deletedAt) {
            deletedFileIds.add(fileDoc.id);
          }
        });
      }
    }

    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data();
      // Filter out soft-deleted files from the count
      const activeFileIds = (data.fileIds || []).filter((id: string) => !deletedFileIds.has(id));
      return {
        id: doc.id,
        date: data.date?.toDate?.()?.toISOString() || data.date,
        dateFormatted: data.date?.toDate?.()?.toLocaleDateString("de-DE") || "",
        amount: data.amount,
        amountFormatted: new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency: data.currency || "EUR",
        }).format((data.amount || 0) / 100),
        name: data.name,
        description: data.description,
        partner: data.partner,
        partnerId: data.partnerId,
        sourceId: data.sourceId,
        fileIds: activeFileIds,
        categoryId: data.categoryId,
        isComplete: data.isComplete || false,
      };
    });

    // Apply client-side filters
    let filtered = transactions;

    if (startDate) {
      const start = new Date(startDate);
      filtered = filtered.filter((t) => new Date(t.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      filtered = filtered.filter((t) => new Date(t.date) <= end);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name?.toLowerCase().includes(searchLower) ||
          t.description?.toLowerCase().includes(searchLower) ||
          t.partner?.toLowerCase().includes(searchLower)
      );
    }

    if (minAmount !== undefined) {
      filtered = filtered.filter((t) => Math.abs(t.amount) >= minAmount * 100);
    }

    if (maxAmount !== undefined) {
      filtered = filtered.filter((t) => Math.abs(t.amount) <= maxAmount * 100);
    }

    // Apply limit to final results
    const totalMatches = filtered.length;
    const limitedResults = filtered.slice(0, limit);

    return {
      transactions: limitedResults,
      total: totalMatches,
      hasMore: totalMatches > limit,
    };
  },
  {
    name: "listTransactions",
    description:
      "List transactions with optional filters. Returns date, amount, partner, description, etc.",
    schema: z.object({
      startDate: z.string().optional().describe("Start date (ISO format)"),
      endDate: z.string().optional().describe("End date (ISO format)"),
      search: z.string().optional().describe("Search in name/description/partner"),
      minAmount: z.number().optional().describe("Minimum amount in EUR"),
      maxAmount: z.number().optional().describe("Maximum amount in EUR"),
      sourceId: z.string().optional().describe("Filter by bank account ID"),
      partnerId: z.string().optional().describe("Filter by partner ID"),
      categoryId: z.string().optional().describe("Filter by category ID"),
      hasFile: z.boolean().optional().describe("Filter by file attachment status"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
  }
);

// ============================================================================
// Get Transaction
// ============================================================================

export const getTransactionTool = tool(
  async ({ transactionId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const doc = await db.collection("transactions").doc(transactionId).get();

    if (!doc.exists) {
      return { error: "Transaction not found" };
    }

    const data = doc.data()!;

    if (data.userId !== userId) {
      return { error: "Transaction not found" };
    }

    return {
      id: doc.id,
      date: data.date?.toDate?.()?.toISOString() || data.date,
      dateFormatted: data.date?.toDate?.()?.toLocaleDateString("de-DE") || "",
      amount: data.amount,
      amountFormatted: new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: data.currency || "EUR",
      }).format((data.amount || 0) / 100),
      name: data.name,
      description: data.description,
      partner: data.partner,
      partnerId: data.partnerId,
      sourceId: data.sourceId,
      fileIds: data.fileIds || [],
      categoryId: data.categoryId,
      isComplete: data.isComplete || false,
      metadata: data.metadata || {},
    };
  },
  {
    name: "getTransaction",
    description: "Get full details of a single transaction by ID",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID"),
    }),
  }
);

// ============================================================================
// List Sources
// ============================================================================

export const listSourcesTool = tool(
  async ({ includeInactive }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    let query = db.collection("sources").where("userId", "==", userId);

    if (!includeInactive) {
      query = query.where("isActive", "==", true);
    }

    const snapshot = await query.get();
    const sources = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        iban: data.iban,
        currency: data.currency || "EUR",
        isActive: data.isActive !== false,
        transactionCount: data.transactionCount || 0,
        lastSync: data.lastSync?.toDate?.()?.toISOString(),
      };
    });

    return {
      sources,
      total: sources.length,
      activeCount: sources.filter((s) => s.isActive).length,
    };
  },
  {
    name: "listSources",
    description: "List all bank accounts/sources",
    schema: z.object({
      includeInactive: z.boolean().optional().describe("Include inactive sources"),
    }),
  }
);

// ============================================================================
// Get Source
// ============================================================================

export const getSourceTool = tool(
  async ({ sourceId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const doc = await db.collection("sources").doc(sourceId).get();

    if (!doc.exists) {
      return { error: "Source not found" };
    }

    const data = doc.data()!;

    if (data.userId !== userId) {
      return { error: "Source not found" };
    }

    return {
      id: doc.id,
      name: data.name,
      iban: data.iban,
      currency: data.currency || "EUR",
      isActive: data.isActive !== false,
      transactionCount: data.transactionCount || 0,
      lastSync: data.lastSync?.toDate?.()?.toISOString(),
    };
  },
  {
    name: "getSource",
    description: "Get details of a single bank account by ID",
    schema: z.object({
      sourceId: z.string().describe("The source/bank account ID"),
    }),
  }
);

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
        changedAt: data.changedAt?.toDate?.()?.toISOString(),
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
// List Files
// ============================================================================

export const listFilesTool = tool(
  async (
    {
      search,
      partnerId,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      hasTransaction,
      limit = 20,
    },
    config
  ) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Note: Can't filter deletedAt at query level since Firestore won't match
    // documents where the field doesn't exist. Filter client-side instead.
    let query = db
      .collection("files")
      .where("userId", "==", userId)
      .orderBy("uploadedAt", "desc");

    // Apply partnerId filter at query level if provided
    if (partnerId) {
      query = query.where("partnerId", "==", partnerId);
    }

    // Fetch more for client-side filtering
    const fetchLimit = search || startDate || endDate || minAmount !== undefined || maxAmount !== undefined ? 500 : limit;
    const snapshot = await query.limit(fetchLimit).get();

    // Filter out soft-deleted files first
    const activeDocs = snapshot.docs.filter((doc) => !doc.data().deletedAt);

    const files = activeDocs.map((doc) => {
      const data = doc.data();
      // Get extracted date if available
      const extractedDate = data.extractedDate?.toDate?.() || data.uploadedAt?.toDate?.();
      // Get extracted amount - apply sign based on invoiceDirection
      // incoming = expense = negative, outgoing = income = positive
      // Convert from cents to whole currency units
      const rawAmount = getEffectiveExtractedAmount(data);
      const signedAmountCents = rawAmount != null
        ? (data.invoiceDirection === "incoming" ? -rawAmount : rawAmount)
        : null;
      const signedAmount = signedAmountCents != null ? signedAmountCents / 100 : null;

      return {
        id: doc.id,
        fileName: data.fileName,
        fileType: data.fileType,
        date: extractedDate?.toISOString() || null,
        dateFormatted: extractedDate?.toLocaleDateString("de-DE") || "—",
        amount: signedAmount,
        amountFormatted: signedAmount != null
          ? new Intl.NumberFormat("de-DE", {
              style: "currency",
              currency: data.extractedCurrency || "EUR",
            }).format(signedAmount)
          : null,
        partnerId: data.partnerId || null,
        partnerName: data.extractedPartner || null,
        transactionIds: data.transactionIds || [],
        hasTransaction: (data.transactionIds || []).length > 0,
        extractionComplete: data.extractionComplete || false,
        isNotInvoice: data.isNotInvoice || false,
        uploadedAt: data.uploadedAt?.toDate?.()?.toISOString(),
      };
    });

    // Apply client-side filters
    let filtered = files;

    if (startDate) {
      const start = new Date(startDate);
      filtered = filtered.filter((f) => f.date && new Date(f.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      filtered = filtered.filter((f) => f.date && new Date(f.date) <= end);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (f) =>
          f.fileName?.toLowerCase().includes(searchLower) ||
          f.partnerName?.toLowerCase().includes(searchLower)
      );
    }

    if (minAmount !== undefined) {
      filtered = filtered.filter((f) => f.amount && Math.abs(f.amount) >= minAmount * 100);
    }

    if (maxAmount !== undefined) {
      filtered = filtered.filter((f) => f.amount && Math.abs(f.amount) <= maxAmount * 100);
    }

    if (hasTransaction !== undefined) {
      filtered = filtered.filter((f) => f.hasTransaction === hasTransaction);
    }

    // Apply limit to final results
    const totalMatches = filtered.length;
    const limitedResults = filtered.slice(0, limit);

    return {
      files: limitedResults,
      total: totalMatches,
      hasMore: totalMatches > limit,
    };
  },
  {
    name: "listFiles",
    description:
      "List uploaded files with optional filters. Returns date, name, amount, partner, and connection status.",
    schema: z.object({
      search: z.string().optional().describe("Search in filename/partner name"),
      partnerId: z.string().optional().describe("Filter by partner ID"),
      startDate: z.string().optional().describe("Start date filter (ISO format)"),
      endDate: z.string().optional().describe("End date filter (ISO format)"),
      minAmount: z.number().optional().describe("Minimum amount in EUR"),
      maxAmount: z.number().optional().describe("Maximum amount in EUR"),
      hasTransaction: z.boolean().optional().describe("Filter by transaction connection status"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
  }
);

// ============================================================================
// Get File
// ============================================================================

export const getFileTool = tool(
  async ({ fileId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const doc = await db.collection("files").doc(fileId).get();

    if (!doc.exists) {
      return { error: `File ${fileId} not found` };
    }

    const data = doc.data()!;

    // Verify ownership
    if (data.userId !== userId) {
      return { error: "Not authorized to access this file" };
    }

    // Get dates
    const extractedDate = data.extractedDate?.toDate?.();
    const uploadedAt = data.uploadedAt?.toDate?.();

    // Get amount with sign based on direction (convert from cents to whole units)
    const rawAmount = getEffectiveExtractedAmount(data);
    const signedAmountCents = rawAmount != null
      ? (data.invoiceDirection === "incoming" ? -rawAmount : rawAmount)
      : null;
    const signedAmount = signedAmountCents != null ? signedAmountCents / 100 : null;

    return {
      id: doc.id,
      fileName: data.fileName,
      fileType: data.fileType,
      fileSize: data.fileSize,
      downloadUrl: data.downloadUrl,
      // Extracted data
      extractedPartner: data.extractedPartner || null,
      extractedAmount: signedAmount,
      extractedAmountFormatted: signedAmount != null
        ? new Intl.NumberFormat("de-DE", {
            style: "currency",
            currency: data.extractedCurrency || "EUR",
          }).format(signedAmount)
        : null,
      extractedCurrency: data.extractedCurrency || "EUR",
      extractedDate: extractedDate?.toISOString() || null,
      extractedDateFormatted: extractedDate?.toLocaleDateString("de-DE") || null,
      extractedVatId: data.extractedVatId || null,
      extractedIban: data.extractedIban || null,
      extractedInvoiceNumber: data.extractedInvoiceNumber || null,
      invoiceDirection: data.invoiceDirection || null,
      // Status
      extractionComplete: data.extractionComplete || false,
      isNotInvoice: data.isNotInvoice || false,
      // Connections
      partnerId: data.partnerId || null,
      partnerType: data.partnerType || null,
      transactionIds: data.transactionIds || [],
      transactionSuggestions: data.transactionSuggestions || [],
      // Metadata
      uploadedAt: uploadedAt?.toISOString() || null,
      // Gmail source info
      gmailSenderEmail: data.gmailSenderEmail || null,
      sourceType: data.sourceType || null,
    };
  },
  {
    name: "getFile",
    description: `Get full details of a file by ID. Returns extracted data (partner, amount, date, VAT ID, IBAN),
connection status (partnerId, transactionIds), and metadata.
Use this to see all information about a specific file before searching for matches.`,
    schema: z.object({
      fileId: z.string().describe("The file ID to get details for"),
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
        const extractedDate = data.extractedDate?.toDate?.();
        const uploadedAt = data.uploadedAt?.toDate?.();

        // Get amount with sign based on direction (convert from cents to whole units)
        const rawAmount = getEffectiveExtractedAmount(data);
        const signedAmountCents = rawAmount != null
          ? (data.invoiceDirection === "incoming" ? -rawAmount : rawAmount)
          : null;
        const signedAmount = signedAmountCents != null ? signedAmountCents / 100 : null;

        console.log(`[waitForFileExtraction] Extraction complete for ${fileId}`);

        return {
          success: true,
          fileId: doc.id,
          extractionComplete: true,
          // Extracted data
          fileName: data.fileName,
          extractedPartner: data.extractedPartner || null,
          extractedAmount: signedAmount,
          extractedAmountFormatted: signedAmount != null
            ? new Intl.NumberFormat("de-DE", {
                style: "currency",
                currency: data.extractedCurrency || "EUR",
              }).format(signedAmount)
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
- extractedAmount: Amount in currency units (negative for expenses)
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
// List Partners
// ============================================================================

export const listPartnersTool = tool(
  async ({ search, limit = 20 }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    let query = db
      .collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .orderBy("name", "asc");

    const snapshot = await query.limit(search ? 100 : limit).get();
    let partners = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        aliases: data.aliases || [],
        vatId: data.vatId || null,
        website: data.website || null,
        country: data.country || null,
        defaultCategoryId: data.defaultCategoryId || null,
      };
    });

    // Client-side search filtering
    if (search) {
      const searchLower = search.toLowerCase();
      partners = partners.filter(
        (p) =>
          p.name?.toLowerCase().includes(searchLower) ||
          p.aliases?.some((a: string) => a.toLowerCase().includes(searchLower)) ||
          p.vatId?.toLowerCase().includes(searchLower)
      );
    }

    // Apply limit after filtering
    const totalMatches = partners.length;
    const limitedResults = partners.slice(0, limit);

    return {
      partners: limitedResults,
      total: totalMatches,
      hasMore: totalMatches > limit,
    };
  },
  {
    name: "listPartners",
    description:
      "List or search partners (vendors/suppliers). Returns name, aliases, VAT ID.",
    schema: z.object({
      search: z.string().optional().describe("Search in name/aliases/VAT ID"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
  }
);

// ============================================================================
// Get Partner
// ============================================================================

export const getPartnerTool = tool(
  async ({ partnerId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const doc = await db.collection("partners").doc(partnerId).get();

    if (!doc.exists) {
      return { error: "Partner not found" };
    }

    const data = doc.data()!;

    if (data.userId !== userId) {
      return { error: "Partner not found" };
    }

    return {
      id: doc.id,
      name: data.name,
      aliases: data.aliases || [],
      address: data.address || null,
      country: data.country || null,
      vatId: data.vatId || null,
      ibans: data.ibans || [],
      website: data.website || null,
      defaultCategoryId: data.defaultCategoryId || null,
      emailDomains: data.emailDomains || [],
    };
  },
  {
    name: "getPartner",
    description: "Get full details of a partner by ID",
    schema: z.object({
      partnerId: z.string().describe("The partner ID"),
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
  lookupCompanyInfoTool,
  validateVatIdTool,
];
