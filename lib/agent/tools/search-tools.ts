/**
 * Search Tools
 *
 * Tools for searching files and receipts across local files and Gmail.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { classifyEmail } from "@/lib/email-providers/interface";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

// Lazy-load admin DB to avoid initialization at build time
let _db: ReturnType<typeof import("@/lib/firebase/admin").getAdminDb> | null = null;
async function getDb() {
  if (!_db) {
    const { getAdminDb } = await import("@/lib/firebase/admin");
    _db = getAdminDb();
  }
  return _db;
}

// Server-side attachment scoring types (matches scoreAttachmentMatchCallable)
interface ScoreAttachmentRequest {
  attachments: Array<{
    key: string;
    filename: string;
    mimeType: string;
    // Email context (for Gmail attachments)
    emailSubject?: string | null;
    emailFrom?: string | null;
    emailSnippet?: string | null;
    emailBodyText?: string | null;
    emailDate?: string | null;
    integrationId?: string | null;
    // File extracted data (for local files)
    fileExtractedAmount?: number | null;
    fileExtractedDate?: string | null;
    fileExtractedPartner?: string | null;
  }>;
  transaction: {
    amount?: number | null;
    date?: string | null;
    name?: string | null;
    reference?: string | null;
    partner?: string | null;
  };
  partner?: {
    name?: string | null;
    emailDomains?: string[] | null;
    fileSourcePatterns?: Array<{
      sourceType: string;
      integrationId?: string;
    }> | null;
  } | null;
}

interface ScoreAttachmentResponse {
  scores: Array<{
    key: string;
    score: number;
    label: "Strong" | "Likely" | null;
    reasons: string[];
  }>;
}

// Types for search query generation
interface TypedSuggestion {
  query: string;
  type: "invoice_number" | "company_name" | "email_domain" | "vat_id" | "iban" | "pattern" | "fallback";
  score: number;
}

interface GenerateSearchQueriesResponse {
  queries: string[];
  suggestions: TypedSuggestion[];
}

// Types for Gmail search callable (matching the Cloud Function)
interface SearchGmailRequest {
  integrationId: string;
  query?: string;
  dateFrom?: string; // ISO date
  dateTo?: string; // ISO date
  from?: string;
  hasAttachments?: boolean;
  limit?: number;
  pageToken?: string;
  expandThreads?: boolean;
}

interface GmailAttachmentResult {
  attachmentId: string;
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
  attachments: GmailAttachmentResult[];
  /** Server-computed classification (includes bodyText analysis) */
  classification?: {
    hasPdfAttachment: boolean;
    possibleMailInvoice: boolean;
    possibleInvoiceLink: boolean;
    confidence: number;
    matchedKeywords?: string[];
  };
}

interface SearchGmailResponse {
  messages: GmailMessageResult[];
  nextPageToken?: string;
  totalEstimate?: number;
}

// ============================================================================
// Generate Search Suggestions (AI-powered query generation)
// ============================================================================

export const generateSearchSuggestionsTool = tool(
  async ({ transactionId }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;

    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Get transaction
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
      return { error: "Transaction not found" };
    }

    const tx = txDoc.data()!;
    const txDate = tx.date?.toDate?.() || new Date(tx.date);

    // Get partner info if available - includes all context useful for agent
    let partnerContext: {
      partnerId: string;
      name: string;
      aliases: string[];
      emailDomains: string[];
      fileSourcePatterns: Array<{ sourceType: string; pattern: string }>;
      website: string | null;
      ibans: string[];
      vatId: string | null;
      // Resolution preference (file vs no-receipt)
      resolution: {
        type: string;
        confidence: number;
        stats: { fileCount: number; noReceiptCount: number };
        preferredNoReceiptCategory: string | null;
      } | null;
    } | null = null;

    if (tx.partnerId) {
      const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
      if (partnerDoc.exists) {
        const partner = partnerDoc.data()!;

        // Build comprehensive partner context
        partnerContext = {
          partnerId: tx.partnerId,
          name: partner.name || "",
          aliases: partner.aliases || [],
          emailDomains: partner.emailDomains || [],
          fileSourcePatterns: (partner.fileSourcePatterns || []).map((p: { sourceType: string; pattern: string }) => ({
            sourceType: p.sourceType,
            pattern: p.pattern,
          })),
          website: partner.website || null,
          ibans: partner.ibans || [],
          vatId: partner.vatId || null,
          resolution: null,
        };

        // Add resolution preference if available
        const pref = partner.resolutionPreference;
        if (pref && pref.type !== "unknown") {
          let preferredNoReceiptCategory: string | null = null;

          // Get category name if partner prefers no-receipt
          if (pref.type === "no_receipt" && pref.preferredNoReceiptCategoryId) {
            try {
              const categoryDoc = await db
                .collection("noReceiptCategories")
                .doc(pref.preferredNoReceiptCategoryId)
                .get();
              if (categoryDoc.exists) {
                preferredNoReceiptCategory = categoryDoc.data()?.name || null;
              }
            } catch {
              // Ignore category fetch errors
            }
          }

          partnerContext.resolution = {
            type: pref.type,
            confidence: pref.confidence,
            stats: {
              fileCount: pref.stats?.fileCount || 0,
              noReceiptCount: pref.stats?.noReceiptCount || 0,
            },
            preferredNoReceiptCategory,
          };
        }
      }
    }

    // Format transaction info for display
    const formattedAmount = new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: tx.currency || "EUR",
    }).format(Math.abs(tx.amount || 0) / 100);

    const formattedDate = txDate.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const transactionInfo = {
      id: transactionId,
      name: tx.name,
      partner: tx.partner || partnerContext?.name,
      amount: tx.amount,
      amountFormatted: formattedAmount,
      date: txDate.toISOString(),
      dateFormatted: formattedDate,
    };

    // Call AI to generate search suggestions
    try {
      const queryResponse = await callFirebaseFunction<
        {
          transaction: {
            name: string;
            partner?: string | null;
            description?: string;
            reference?: string;
            partnerId?: string | null;
            partnerType?: "global" | "user" | null;
            amount?: number;
          };
          maxQueries?: number;
        },
        GenerateSearchQueriesResponse
      >(
        "generateSearchQueriesCallable",
        {
          transaction: {
            name: tx.name || "",
            partner: tx.partner,
            description: tx.description,
            reference: tx.reference,
            partnerId: tx.partnerId,
            partnerType: tx.partnerType,
            amount: tx.amount,
          },
          maxQueries: 6,
        },
        authHeader
      );

      const suggestions = queryResponse?.suggestions || [];
      const queries = queryResponse?.queries || [];

      // Build hint based on partner resolution preference
      let resolutionHint: string | undefined;
      if (partnerContext?.resolution) {
        if (partnerContext.resolution.type === "no_receipt") {
          resolutionHint = `Partner "${partnerContext.name}" typically doesn't need receipts (${partnerContext.resolution.preferredNoReceiptCategory || "no-receipt category"}). Consider suggesting a no-receipt category instead of searching for files.`;
        } else if (partnerContext.resolution.type === "mixed") {
          resolutionHint = `Partner "${partnerContext.name}" is mixed (${partnerContext.resolution.stats.fileCount} files, ${partnerContext.resolution.stats.noReceiptCount} no-receipt). Check both file search and no-receipt category options.`;
        }
      }

      return {
        transaction: transactionInfo,
        partnerContext,
        suggestions: suggestions.map((s) => ({
          query: s.query,
          type: s.type,
          typeLabel: s.type === "invoice_number" ? "Invoice #"
            : s.type === "company_name" ? "Company"
            : s.type === "email_domain" ? "Email"
            : s.type === "vat_id" ? "VAT ID"
            : s.type === "iban" ? "IBAN"
            : s.type === "pattern" ? "Pattern"
            : s.type,
          score: s.score,
        })),
        queries,
        resolutionHint,
        summary: queries.length > 0
          ? `Generated ${queries.length} search queries: ${queries.slice(0, 3).join(", ")}${queries.length > 3 ? "..." : ""}`
          : "No search queries generated",
        nextSteps: resolutionHint || "Use searchLocalFiles to check uploaded files, then searchGmailAttachments with each query to search Gmail.",
      };
    } catch (err) {
      console.error("[generateSearchSuggestions] AI query generation failed:", err);

      // Fallback to basic queries
      const partnerName = tx.partner || partnerContext?.name || tx.name;
      const fallbackQueries = partnerName
        ? [partnerName, `${partnerName} invoice`, `${partnerName} rechnung`]
        : [];

      // Build hint based on partner resolution preference
      let resolutionHint: string | undefined;
      if (partnerContext?.resolution) {
        if (partnerContext.resolution.type === "no_receipt") {
          resolutionHint = `Partner "${partnerContext.name}" typically doesn't need receipts (${partnerContext.resolution.preferredNoReceiptCategory || "no-receipt category"}). Consider suggesting a no-receipt category instead of searching for files.`;
        } else if (partnerContext.resolution.type === "mixed") {
          resolutionHint = `Partner "${partnerContext.name}" is mixed (${partnerContext.resolution.stats.fileCount} files, ${partnerContext.resolution.stats.noReceiptCount} no-receipt). Check both file search and no-receipt category options.`;
        }
      }

      return {
        transaction: transactionInfo,
        partnerContext,
        suggestions: [],
        queries: fallbackQueries,
        resolutionHint,
        summary: fallbackQueries.length > 0
          ? `AI generation failed. Fallback queries: ${fallbackQueries.join(", ")}`
          : "Could not generate search queries",
        error: "AI query generation failed, using fallback queries",
        nextSteps: resolutionHint || "Use searchLocalFiles to check uploaded files, then searchGmailAttachments with each query.",
      };
    }
  },
  {
    name: "generateSearchSuggestions",
    description: `Generate AI-powered search suggestions for finding a receipt/invoice for a transaction.

Call this FIRST when searching for a receipt. Returns optimized search queries based on:
- Transaction name and partner
- Invoice numbers found in description
- Email domains associated with partner

After getting suggestions, use:
1. searchLocalFiles to check uploaded files
2. searchGmailAttachments with each suggested query`,
    schema: z.object({
      transactionId: z.string().describe("The transaction ID to generate search suggestions for"),
    }),
  }
);

// ============================================================================
// Search Local Files
// ============================================================================

export const searchLocalFilesTool = tool(
  async ({ transactionId, strategy }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Get transaction
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
      return { error: "Transaction not found" };
    }

    const tx = txDoc.data()!;
    const txDate = tx.date?.toDate?.() || new Date(tx.date);
    const rejectedFileIds = new Set<string>(tx.rejectedFileIds || []);

    // Get partner info if available - includes all context useful for agent
    let partnerContext: {
      partnerId: string;
      name: string;
      aliases: string[];
      emailDomains: string[];
      fileSourcePatterns: Array<{ sourceType: string; pattern: string }>;
      website: string | null;
      ibans: string[];
      vatId: string | null;
      resolution: {
        type: string;
        confidence: number;
        stats: { fileCount: number; noReceiptCount: number };
        preferredNoReceiptCategory: string | null;
      } | null;
    } | null = null;

    // Also keep partner data for scoring API
    let partner = null;

    if (tx.partnerId) {
      const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
      if (partnerDoc.exists) {
        const partnerData = partnerDoc.data()!;
        partner = partnerData;

        // Build comprehensive partner context
        partnerContext = {
          partnerId: tx.partnerId,
          name: partnerData.name || "",
          aliases: partnerData.aliases || [],
          emailDomains: partnerData.emailDomains || [],
          fileSourcePatterns: (partnerData.fileSourcePatterns || []).map((p: { sourceType: string; pattern: string }) => ({
            sourceType: p.sourceType,
            pattern: p.pattern,
          })),
          website: partnerData.website || null,
          ibans: partnerData.ibans || [],
          vatId: partnerData.vatId || null,
          resolution: null,
        };

        // Add resolution preference if available
        const pref = partnerData.resolutionPreference;
        if (pref && pref.type !== "unknown") {
          let preferredNoReceiptCategory: string | null = null;

          // Get category name if partner prefers no-receipt
          if (pref.type === "no_receipt" && pref.preferredNoReceiptCategoryId) {
            try {
              const categoryDoc = await db
                .collection("noReceiptCategories")
                .doc(pref.preferredNoReceiptCategoryId)
                .get();
              if (categoryDoc.exists) {
                preferredNoReceiptCategory = categoryDoc.data()?.name || null;
              }
            } catch {
              // Ignore category fetch errors
            }
          }

          partnerContext.resolution = {
            type: pref.type,
            confidence: pref.confidence,
            stats: {
              fileCount: pref.stats?.fileCount || 0,
              noReceiptCount: pref.stats?.noReceiptCount || 0,
            },
            preferredNoReceiptCategory,
          };
        }
      }
    }

    // Get all unconnected files
    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("transactionIds", "==", [])
      .where("isNotInvoice", "!=", true)
      .get();

    // Define file type for eligible files
    interface EligibleFile {
      id: string;
      fileName: string;
      fileType: string;
      deletedAt?: unknown;
      extractedAmount?: number;
      extractedCurrency?: string;
      extractedDate?: { toDate?: () => Date };
      extractedPartner?: string;
    }

    // Filter to eligible files (PDFs and images, not soft-deleted)
    const eligibleFiles: EligibleFile[] = filesSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() } as EligibleFile))
      .filter((file) => {
        if (file.deletedAt) return false;
        return file.fileType === "application/pdf" || file.fileType?.startsWith("image/");
      });

    if (eligibleFiles.length === 0) {
      // Build hint if partner prefers no-receipt
      let resolutionHint: string | undefined;
      if (partnerContext?.resolution?.type === "no_receipt") {
        resolutionHint = `Partner "${partnerContext.name}" typically doesn't need receipts. Consider suggesting the "${partnerContext.resolution.preferredNoReceiptCategory || "no-receipt"}" category.`;
      }

      return {
        searchType: "local_files",
        strategy: strategy || "all",
        searchedTransaction: {
          id: transactionId,
          name: tx.name,
          partner: tx.partner,
          amount: tx.amount,
          date: txDate.toISOString(),
        },
        partnerContext,
        resolutionHint,
        summary: resolutionHint
          ? `No uploaded files available. ${resolutionHint}`
          : "No uploaded files available to search",
        candidates: [],
        totalFound: 0,
      };
    }

    // Build attachments list for scoring API
    const attachmentsToScore = eligibleFiles.map((file) => ({
      key: `local_${file.id}`,
      filename: file.fileName,
      mimeType: file.fileType,
      // Pass file extracted data for accurate scoring
      fileExtractedAmount: getFileAmountForValidation(file, tx.amount),
      fileExtractedDate: file.extractedDate?.toDate?.()?.toISOString() ?? null,
      fileExtractedPartner: file.extractedPartner ?? null,
    }));

    // Score all files using real-time scoring (same as UI does)
    let candidates: Array<{
      id: string;
      sourceType: "local_file";
      score: number;
      scoreLabel: string | null;
      scoreReasons: string[];
      fileId: string;
      fileName: string;
      extractedAmount?: number;
      extractedCurrency?: string;
      extractedDate?: string;
      extractedPartner?: string;
      isRejected?: boolean;
    }> = [];

    try {
      const scoreResponse = await callFirebaseFunction<ScoreAttachmentRequest, ScoreAttachmentResponse>(
        "scoreAttachmentMatchCallable",
        {
          attachments: attachmentsToScore,
          transaction: {
            amount: tx.amount,
            date: txDate.toISOString(),
            name: tx.name,
            partner: tx.partner,
          },
          partner: partner ? {
            name: partner.name,
            emailDomains: partner.emailDomains,
            fileSourcePatterns: partner.fileSourcePatterns,
          } : null,
        },
        authHeader
      );

      // Map scores back to candidates
      const scoreMap = new Map(scoreResponse.scores.map((s) => [s.key, s]));

      for (const file of eligibleFiles) {
        const key = `local_${file.id}`;
        const scoreResult = scoreMap.get(key);

        if (scoreResult && scoreResult.score > 0) {
          // Apply strategy filter based on score reasons
          if (strategy === "partner_files") {
            const hasPartnerSignal = scoreResult.reasons.some(
              (r) => r.toLowerCase().includes("partner") || r.toLowerCase().includes("vendor")
            );
            if (!hasPartnerSignal) continue;
          }

          if (strategy === "amount_files") {
            const hasAmountSignal = scoreResult.reasons.some(
              (r) => r.toLowerCase().includes("amount")
            );
            if (!hasAmountSignal) continue;
          }

          const candidateAmount = getFileAmountForValidation(file, tx.amount);

          candidates.push({
            id: key,
            sourceType: "local_file",
            score: scoreResult.score,
            scoreLabel: scoreResult.label,
            scoreReasons: scoreResult.reasons,
            fileId: file.id,
            fileName: file.fileName,
            // Convert from cents to whole units for display
            extractedAmount: candidateAmount != null ? candidateAmount / 100 : undefined,
            extractedCurrency: file.extractedCurrency || "EUR",
            extractedDate: file.extractedDate?.toDate?.()?.toISOString() ?? undefined,
            extractedPartner: file.extractedPartner ?? undefined,
            isRejected: rejectedFileIds.has(file.id),
          });
        }
      }
    } catch (err) {
      console.error("[searchLocalFiles] Error scoring files:", err);
      return {
        searchType: "local_files",
        strategy: strategy || "all",
        searchedTransaction: {
          id: transactionId,
          name: tx.name,
          partner: tx.partner,
          amount: tx.amount,
          date: txDate.toISOString(),
        },
        partnerContext,
        summary: "Error scoring files - please try again",
        candidates: [],
        totalFound: 0,
      };
    }

    // Sort by score
    candidates.sort((a, b) => b.score - a.score);

    const topCandidates = candidates.slice(0, 10);

    // Build hint if no files found but partner prefers no-receipt
    let resolutionHint: string | undefined;
    if (candidates.length === 0 && partnerContext?.resolution?.type === "no_receipt") {
      resolutionHint = `Partner "${partnerContext.name}" typically doesn't need receipts. Consider suggesting the "${partnerContext.resolution.preferredNoReceiptCategory || "no-receipt"}" category.`;
    } else if (partnerContext?.resolution?.type === "mixed") {
      resolutionHint = `Partner is mixed (${partnerContext.resolution.stats.fileCount} files, ${partnerContext.resolution.stats.noReceiptCount} no-receipt historically).`;
    }

    return {
      searchType: "local_files",
      strategy: strategy || "all",
      searchedTransaction: {
        id: transactionId,
        name: tx.name,
        partner: tx.partner,
        amount: tx.amount,
        date: txDate.toISOString(),
      },
      partnerContext,
      resolutionHint,
      summary:
        candidates.length > 0
          ? `Found ${candidates.length} files. Top match: "${topCandidates[0]?.fileName}" (${topCandidates[0]?.score}%)`
          : resolutionHint
            ? `No matching files found. ${resolutionHint}`
            : "No matching files found",
      candidates: topCandidates.map((c) => ({
        ...c,
        scoreDetails: `${c.score}% - ${c.scoreReasons?.join(", ") || "no reasons"}`,
      })),
      totalFound: candidates.length,
    };
  },
  {
    name: "searchLocalFiles",
    description:
      "Search uploaded files that might match a transaction. Scores files by amount, date, and partner match. Returns candidates with scores.",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID to find files for"),
      strategy: z
        .enum(["all", "partner_files", "amount_files"])
        .optional()
        .describe("Search strategy"),
    }),
  }
);

// ============================================================================
// Search Gmail Attachments
// ============================================================================

export const searchGmailAttachmentsTool = tool(
  async ({ transactionId, query }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;

    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Get transaction
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
      return { error: "Transaction not found" };
    }

    const tx = txDoc.data()!;
    const txDate = tx.date?.toDate?.() || new Date(tx.date);

    // Get partner info if available
    let partner = null;
    if (tx.partnerId) {
      const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
      if (partnerDoc.exists) {
        partner = partnerDoc.data();
      }
    }

    // Get Gmail integrations
    const integrationsSnapshot = await db
      .collection("emailIntegrations")
      .where("userId", "==", userId)
      .where("provider", "==", "gmail")
      .where("isActive", "==", true)
      .get();

    if (integrationsSnapshot.empty) {
      return {
        searchType: "gmail_attachments",
        gmailNotConnected: true,
        error: "Gmail is not connected. Connect Gmail to search email attachments.",
        candidates: [],
        queriesUsed: query ? [query] : [],
        totalFound: 0,
        integrationCount: 0,
      };
    }

    // Check for integrations needing reauth (isPaused is only for sync, not search)
    const integrationsNeedingReauth = integrationsSnapshot.docs
      .filter((doc) => {
        const data = doc.data();
        return data.needsReauth === true;
      })
      .map((doc) => {
        const data = doc.data();
        return {
          integrationId: doc.id,
          email: data.email,
          needsReauth: true,
        };
      });

    // Build search queries with variations (matching UI behavior)
    const searchQueriesSet = new Set<string>();

    const addQueryVariations = (baseQuery: string) => {
      if (!baseQuery || baseQuery.trim().length < 2) return;

      const cleaned = baseQuery.trim();
      searchQueriesSet.add(cleaned);

      // Add first word only (for compound names like "autotrading school" -> "autotrading")
      const words = cleaned.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 1) {
        searchQueriesSet.add(words[0]);
      }

      // Add without spaces for concatenated names
      if (cleaned.includes(" ")) {
        searchQueriesSet.add(cleaned.replace(/\s+/g, ""));
      }

      // Add from: prefix if it looks like a domain or email
      const isDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned);
      const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned);
      if (isDomain || isEmail) {
        searchQueriesSet.add(`from:${cleaned}`);
      }
    };

    if (query) {
      addQueryVariations(query);
    } else {
      // Auto-generate queries based on transaction
      const partnerName = tx.partner || tx.name;
      if (partnerName) {
        // Clean bank transaction names (remove prefixes like "Tbl*", truncation indicators)
        const cleanedPartner = partnerName
          .replace(/^(Tbl\*|To |From |SEPA |Überweisung |Lastschrift )/i, "")
          .replace(/\.{3}$/, "") // Remove trailing ...
          .trim();

        addQueryVariations(cleanedPartner);
        searchQueriesSet.add(`${cleanedPartner} rechnung`);
        searchQueriesSet.add(`${cleanedPartner} invoice`);
      }

      // Add partner email domains if available (high-value searches)
      if (partner?.emailDomains && Array.isArray(partner.emailDomains)) {
        for (const domain of partner.emailDomains.slice(0, 3)) {
          searchQueriesSet.add(`from:${domain}`);
        }
      }
    }

    const searchQueries = Array.from(searchQueriesSet);

    const allCandidates: Array<{
      id: string;
      sourceType: "gmail_attachment" | "gmail_email";
      score: number;
      scoreLabel: string | null;
      scoreReasons: string[];
      messageId: string;
      attachmentId?: string;
      attachmentFilename?: string;
      emailSubject?: string;
      emailFrom?: string;
      emailDate?: string;
      integrationId: string;
      classification?: {
        hasPdfAttachment: boolean;
        possibleMailInvoice: boolean;
        possibleInvoiceLink: boolean;
      };
      /** If already downloaded, the existing file ID */
      alreadyDownloaded?: boolean;
      existingFileId?: string;
    }> = [];

    for (const integrationDoc of integrationsSnapshot.docs) {
      const integration = integrationDoc.data();
      console.log("[searchGmailAttachments] Searching integration:", integration.email);

      for (const searchQuery of searchQueries) {
        try {
          // Call searchGmailCallable directly (same as UI does)
          // No date filtering - invoices may arrive weeks/months before or after transaction
          const searchResponse = await callFirebaseFunction<SearchGmailRequest, SearchGmailResponse>(
            "searchGmailCallable",
            {
              integrationId: integrationDoc.id,
              query: searchQuery,
              hasAttachments: false, // Get all emails, we'll classify them
              expandThreads: true, // Fetch all messages in matching threads
              limit: 50, // Match UI limit for better coverage
            },
            authHeader
          );

          const messages = searchResponse?.messages || [];
          console.log("[searchGmailAttachments] Found", messages.length, "messages for query:", searchQuery);

          // Collect attachments to score via server-side callable
          const attachmentsToScore: Array<{
            key: string;
            filename: string;
            mimeType: string;
            emailSubject?: string;
            emailFrom?: string;
            emailSnippet?: string;
            emailBodyText?: string;
            emailDate?: string;
            integrationId: string;
            // Metadata for building candidates after scoring
            _messageId: string;
            _attachmentId?: string;
            _classification: ReturnType<typeof classifyEmail>;
            _sourceType: "gmail_attachment" | "gmail_email";
            _alreadyDownloaded?: boolean;
            _existingFileId?: string;
          }> = [];

          for (const message of messages) {
            // Use server-computed classification (includes bodyText analysis) for consistency
            // Fallback to basic classification if server didn't provide one
            const classification = message.classification || {
              hasPdfAttachment: message.attachments?.some((a) => a.mimeType === "application/pdf") || false,
              possibleMailInvoice: false,
              possibleInvoiceLink: false,
              confidence: 20,
              matchedKeywords: [] as string[],
            };

            // Collect PDF attachments for scoring
            for (const attachment of message.attachments || []) {
              // Only include PDFs - images are usually logos/signatures, not receipts
              const isPdf = attachment.mimeType === "application/pdf" ||
                (attachment.mimeType === "application/octet-stream" &&
                  attachment.filename?.toLowerCase().endsWith(".pdf"));
              if (!isPdf) {
                continue;
              }

              // Mark already-downloaded attachments (don't skip them)
              const alreadyDownloaded = !!attachment.existingFileId;

              attachmentsToScore.push({
                key: `gmail_${message.messageId}_${attachment.attachmentId}`,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                emailSubject: message.subject,
                emailFrom: message.from,
                emailSnippet: message.snippet,
                emailBodyText: message.bodyText ?? undefined,
                emailDate: message.date,
                integrationId: integrationDoc.id,
                _messageId: message.messageId,
                _attachmentId: attachment.attachmentId,
                _classification: classification,
                _sourceType: "gmail_attachment",
                _alreadyDownloaded: alreadyDownloaded,
                _existingFileId: attachment.existingFileId || undefined,
              });
            }

            // If it's a mail invoice (no attachment), add the email itself
            if (classification.possibleMailInvoice && !classification.hasPdfAttachment) {
              attachmentsToScore.push({
                key: `gmail_email_${message.messageId}`,
                filename: `${message.subject || "email"}.pdf`,
                mimeType: "text/html",
                emailSubject: message.subject,
                emailFrom: message.from,
                emailSnippet: message.snippet,
                emailBodyText: message.bodyText ?? undefined,
                emailDate: message.date,
                integrationId: integrationDoc.id,
                _messageId: message.messageId,
                _classification: classification,
                _sourceType: "gmail_email",
              });
            }
          }

          // Score all attachments via server-side callable (batched for efficiency)
          if (attachmentsToScore.length > 0) {
            try {
              const scoreResponse = await callFirebaseFunction<ScoreAttachmentRequest, ScoreAttachmentResponse>(
                "scoreAttachmentMatchCallable",
                {
                  attachments: attachmentsToScore.map((a) => ({
                    key: a.key,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    emailSubject: a.emailSubject,
                    emailFrom: a.emailFrom,
                    emailSnippet: a.emailSnippet,
                    emailBodyText: a.emailBodyText,
                    emailDate: a.emailDate,
                    integrationId: a.integrationId,
                    // Include classification for scoring boost (+15% for mail invoice, +10% for invoice link)
                    classification: a._classification ? {
                      hasPdfAttachment: a._classification.hasPdfAttachment,
                      possibleMailInvoice: a._classification.possibleMailInvoice,
                      possibleInvoiceLink: a._classification.possibleInvoiceLink,
                      confidence: a._classification.confidence,
                    } : undefined,
                  })),
                  transaction: {
                    amount: tx.amount,
                    date: txDate.toISOString(),
                    name: tx.name,
                    reference: tx.reference, // Include reference for invoice reference matching (+10%)
                    partner: tx.partner,
                  },
                  partner: partner ? {
                    name: partner.name,
                    emailDomains: partner.emailDomains,
                    fileSourcePatterns: partner.fileSourcePatterns,
                  } : null,
                },
                authHeader
              );

              // Map scores back to candidates
              const scoreMap = new Map(scoreResponse.scores.map((s) => [s.key, s]));
              for (const att of attachmentsToScore) {
                const scoreResult = scoreMap.get(att.key);
                if (scoreResult) {
                  // Build reasons, adding "Already downloaded" if applicable
                  const reasons = att._sourceType === "gmail_email"
                    ? [...scoreResult.reasons, "Possible mail invoice"]
                    : scoreResult.reasons;
                  if (att._alreadyDownloaded) {
                    reasons.unshift("✓ Already downloaded");
                  }

                  allCandidates.push({
                    id: att.key,
                    sourceType: att._sourceType,
                    score: scoreResult.score,
                    scoreLabel: scoreResult.label,
                    scoreReasons: reasons,
                    messageId: att._messageId,
                    attachmentId: att._attachmentId,
                    attachmentFilename: att.filename,
                    emailSubject: att.emailSubject,
                    emailFrom: att.emailFrom,
                    emailDate: att.emailDate,
                    integrationId: att.integrationId,
                    classification: att._classification,
                    alreadyDownloaded: att._alreadyDownloaded,
                    existingFileId: att._existingFileId,
                  });
                }
              }
            } catch (scoreErr) {
              console.error("[searchGmailAttachments] Error scoring attachments:", scoreErr);
            }
          }
        } catch (err) {
          console.error(
            `[searchGmailAttachments] Error searching Gmail integration ${integrationDoc.id}:`,
            err
          );
        }
      }
    }

    // Sort by score
    allCandidates.sort((a, b) => b.score - a.score);

    // Deduplicate by messageId + attachmentId
    const seen = new Set<string>();
    const dedupedCandidates = allCandidates.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    const topCandidates = dedupedCandidates.slice(0, 15);
    const alreadyDownloadedCount = dedupedCandidates.filter((c) => c.alreadyDownloaded).length;

    // Build summary
    let summary: string;
    if (dedupedCandidates.length > 0) {
      const topInfo = `Top: "${topCandidates[0]?.attachmentFilename || topCandidates[0]?.emailSubject}" (${topCandidates[0]?.score}%)`;
      const downloadedInfo = alreadyDownloadedCount > 0
        ? ` (${alreadyDownloadedCount} already downloaded)`
        : "";
      summary = `Searched "${searchQueries.join('", "')}" - Found ${dedupedCandidates.length} attachments${downloadedInfo}. ${topInfo}`;
    } else {
      summary = `Searched "${searchQueries.join('", "')}" - No attachments found`;
    }

    return {
      searchType: "gmail_attachments",
      searchedTransaction: {
        id: transactionId,
        name: tx.name,
        partner: tx.partner,
        amount: tx.amount,
        date: txDate.toISOString(),
      },
      queriesUsed: searchQueries,
      summary,
      candidates: topCandidates.map((c) => ({
        ...c,
        scoreDetails: `${c.score}% - ${c.scoreReasons?.join(", ") || "no reasons"}`,
      })),
      totalFound: dedupedCandidates.length,
      alreadyDownloadedCount,
      integrationCount: integrationsSnapshot.size,
      integrationsNeedingReauth: integrationsNeedingReauth.length > 0 ? integrationsNeedingReauth : undefined,
    };
  },
  {
    name: "searchGmailAttachments",
    description: `Search Gmail for email attachments that might be receipts for a transaction.

Returns candidates with scores. Each candidate includes:
- alreadyDownloaded: true if this attachment was previously downloaded
- existingFileId: the file ID if already downloaded (can be connected directly)

If a high-scoring candidate is alreadyDownloaded, use connectFileToTransaction with existingFileId.
If not downloaded, use downloadGmailAttachment to download it first.`,
    schema: z.object({
      transactionId: z.string().describe("The transaction ID to find attachments for"),
      query: z
        .string()
        .optional()
        .describe("Custom Gmail search query. If not provided, auto-generates based on transaction."),
    }),
  }
);

// ============================================================================
// Search Gmail Emails (broader email search with classification)
// ============================================================================

export const searchGmailEmailsTool = tool(
  async ({ query, transactionId, dateFrom, dateTo, from, limit }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;

    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Get transaction context if provided (for scoring)
    let tx = null;
    let partner = null;
    if (transactionId) {
      const txDoc = await db.collection("transactions").doc(transactionId).get();
      if (txDoc.exists && txDoc.data()?.userId === userId) {
        tx = txDoc.data();
        if (tx?.partnerId) {
          const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
          if (partnerDoc.exists) {
            partner = partnerDoc.data();
          }
        }
      }
    }

    // Get Gmail integrations
    const integrationsSnapshot = await db
      .collection("emailIntegrations")
      .where("userId", "==", userId)
      .where("provider", "==", "gmail")
      .where("isActive", "==", true)
      .get();

    if (integrationsSnapshot.empty) {
      return {
        searchType: "gmail_emails",
        query: query || "",
        gmailNotConnected: true,
        error: "Gmail is not connected. Connect Gmail to search emails.",
        emails: [],
        totalFound: 0,
        integrationCount: 0,
      };
    }

    // Check for integrations needing reauth
    const integrationsNeedingReauth = integrationsSnapshot.docs
      .filter((doc) => {
        const data = doc.data();
        return data.needsReauth === true;
      })
      .map((doc) => {
        const data = doc.data();
        return {
          integrationId: doc.id,
          email: data.email,
          needsReauth: true,
        };
      });

    const allEmails: Array<{
      messageId: string;
      threadId: string;
      subject: string;
      from: string;
      fromName: string | null;
      date: string;
      snippet: string;
      bodyText: string | null;
      integrationId: string;
      integrationEmail?: string;
      attachmentCount: number;
      classification: {
        hasPdfAttachment: boolean;
        possibleMailInvoice: boolean;
        possibleInvoiceLink: boolean;
        confidence: number;
        matchedKeywords?: string[];
      };
    }> = [];

    for (const integrationDoc of integrationsSnapshot.docs) {
      const integration = integrationDoc.data();

      try {
        const searchResponse = await callFirebaseFunction<SearchGmailRequest, SearchGmailResponse>(
          "searchGmailCallable",
          {
            integrationId: integrationDoc.id,
            query,
            dateFrom,
            dateTo,
            from,
            hasAttachments: false, // Get all emails, not just those with attachments
            expandThreads: true,
            limit: limit || 30,
          },
          authHeader
        );

        const messages = searchResponse?.messages || [];

        for (const message of messages) {
          // Use server-computed classification (includes bodyText analysis)
          // Fallback to basic classification if server didn't provide one
          const classification = message.classification || {
            hasPdfAttachment: message.attachments?.some((a) => a.mimeType === "application/pdf") || false,
            possibleMailInvoice: false,
            possibleInvoiceLink: false,
            confidence: 20,
            matchedKeywords: [],
          };

          allEmails.push({
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            from: message.from,
            fromName: message.fromName,
            date: message.date,
            snippet: message.snippet,
            bodyText: message.bodyText,
            integrationId: integrationDoc.id,
            integrationEmail: integration.email,
            attachmentCount: message.attachments?.length || 0,
            classification,
          });
        }
      } catch (err) {
        console.error(`[searchGmailEmails] Error searching integration ${integrationDoc.id}:`, err);
      }
    }

    // Deduplicate by messageId
    const seen = new Set<string>();
    const dedupedEmails = allEmails.filter((e) => {
      if (seen.has(e.messageId)) return false;
      seen.add(e.messageId);
      return true;
    });

    // Score emails using the same server-side scoring as the UI (if transaction context provided)
    let scoredEmails = dedupedEmails.map((e) => ({
      ...e,
      score: e.classification.confidence,
      scoreLabel: null as "Strong" | "Likely" | null,
      scoreReasons: e.classification.matchedKeywords || [],
    }));

    if (tx && dedupedEmails.length > 0) {
      try {
        const txDate = tx.date?.toDate?.() || new Date(tx.date);
        const emailsToScore = dedupedEmails.map((email) => ({
          key: email.messageId,
          filename: `${email.subject}.pdf`,
          mimeType: "application/pdf",
          emailSubject: email.subject,
          emailFrom: email.from,
          emailSnippet: email.snippet,
          emailBodyText: email.bodyText,
          emailDate: email.date,
          integrationId: email.integrationId,
          classification: email.classification,
        }));

        const scoreResponse = await callFirebaseFunction<ScoreAttachmentRequest, ScoreAttachmentResponse>(
          "scoreAttachmentMatchCallable",
          {
            attachments: emailsToScore,
            transaction: {
              amount: tx.amount,
              date: txDate.toISOString(),
              name: tx.name,
              partner: tx.partner,
            },
            partner: partner ? {
              name: partner.name,
              emailDomains: partner.emailDomains,
              fileSourcePatterns: partner.fileSourcePatterns,
            } : null,
          },
          authHeader
        );

        // Map scores back to emails
        const scoreMap = new Map(scoreResponse.scores.map((s) => [s.key, s]));
        scoredEmails = dedupedEmails.map((email) => {
          const scoreResult = scoreMap.get(email.messageId);
          return {
            ...email,
            score: scoreResult?.score ?? email.classification.confidence,
            scoreLabel: scoreResult?.label ?? null,
            scoreReasons: scoreResult?.reasons ?? email.classification.matchedKeywords ?? [],
          };
        });
      } catch (err) {
        console.error("[searchGmailEmails] Error scoring emails:", err);
        // Fall back to classification confidence
      }
    }

    // Sort by score (from server scoring or classification), then by date
    scoredEmails.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    // Limit results and strip bodyText to avoid token explosion
    // bodyText is only needed for server-side scoring, not for agent output
    const resultEmails = scoredEmails.slice(0, 10).map(({ bodyText, ...rest }) => ({
      ...rest,
      // Provide truncated snippet if bodyText exists but snippet is empty
      snippet: rest.snippet || (bodyText ? bodyText.slice(0, 200) + "..." : ""),
    }));

    return {
      searchType: "gmail_emails",
      query,
      emails: resultEmails,
      totalFound: dedupedEmails.length,
      integrationCount: integrationsSnapshot.size,
      integrationsNeedingReauth: integrationsNeedingReauth.length > 0 ? integrationsNeedingReauth : undefined,
      summary: resultEmails.length > 0
        ? `Found ${dedupedEmails.length} emails for "${query}". ${resultEmails.filter(e => e.classification.possibleMailInvoice).length} may be mail invoices, ${resultEmails.filter(e => e.classification.possibleInvoiceLink).length} may have invoice links.`
        : `No emails found for "${query}"`,
    };
  },
  {
    name: "searchGmailEmails",
    description:
      "Search Gmail for emails matching a query. Returns emails with classification (mail invoice, invoice link, attachments). Use to find order confirmations, booking receipts, or emails with invoice download links.",
    schema: z.object({
      query: z.string().describe("Gmail search query (e.g., 'Netflix receipt', 'from:amazon.de')"),
      transactionId: z.string().optional().describe("Transaction ID for context (optional)"),
      dateFrom: z.string().optional().describe("Start date filter (ISO format)"),
      dateTo: z.string().optional().describe("End date filter (ISO format)"),
      from: z.string().optional().describe("Filter by sender email/domain"),
      limit: z.number().optional().describe("Max results per integration (default 30)"),
    }),
  }
);

// ============================================================================
// Analyze Email for Invoice (Gemini-powered deep analysis)
// ============================================================================

interface AnalyzeEmailResponse {
  messageId: string;
  subject: string;
  from: string;
  date?: string;
  hasInvoiceLink: boolean;
  invoiceLinks: Array<{ url: string; anchorText?: string }>;
  isMailInvoice: boolean;
  mailInvoiceConfidence: number;
  reasoning: string;
}

export const analyzeEmailTool = tool(
  async ({ integrationId, messageId, transactionId }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;

    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

    // Verify integration belongs to user
    const integrationDoc = await db.collection("emailIntegrations").doc(integrationId).get();
    if (!integrationDoc.exists || integrationDoc.data()?.userId !== userId) {
      return { error: "Gmail integration not found" };
    }

    // Get transaction context if provided
    let transaction = null;
    if (transactionId) {
      const txDoc = await db.collection("transactions").doc(transactionId).get();
      if (txDoc.exists && txDoc.data()?.userId === userId) {
        const tx = txDoc.data()!;
        transaction = {
          name: tx.name,
          partner: tx.partner,
          amount: tx.amount,
        };
      }
    }

    // Call the analyze-email API
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const response = await fetch(`${baseUrl}/api/gmail/analyze-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        integrationId,
        messageId,
        transaction,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        error: errorData.error || `Analysis failed: ${response.status}`,
        code: errorData.code,
      };
    }

    const result: AnalyzeEmailResponse = await response.json();

    return {
      messageId: result.messageId,
      subject: result.subject,
      from: result.from,
      date: result.date,
      hasInvoiceLink: result.hasInvoiceLink,
      invoiceLinks: result.invoiceLinks,
      isMailInvoice: result.isMailInvoice,
      mailInvoiceConfidence: result.mailInvoiceConfidence,
      reasoning: result.reasoning,
      summary: result.hasInvoiceLink
        ? `Found ${result.invoiceLinks.length} invoice link(s): ${result.invoiceLinks.map(l => l.anchorText || l.url).join(", ")}`
        : result.isMailInvoice
          ? `Email IS an invoice (${Math.round(result.mailInvoiceConfidence * 100)}% confidence)`
          : "No invoice content detected",
    };
  },
  {
    name: "analyzeEmail",
    description:
      "Use AI to deeply analyze an email for invoice content. Determines if the email body IS an invoice, or if it contains links to download an invoice. Returns extracted URLs and confidence scores.",
    schema: z.object({
      integrationId: z.string().describe("Gmail integration ID"),
      messageId: z.string().describe("Gmail message ID to analyze"),
      transactionId: z.string().optional().describe("Transaction ID for context (improves accuracy)"),
    }),
  }
);

// ============================================================================
// Get Partner Receipt Hints
// ============================================================================

interface ConnectFileRequest {
  fileId: string;
  transactionId: string;
  connectionType?: "manual" | "auto_matched";
  matchConfidence?: number | null;
  sourceInfo?: {
    sourceType?: string;
    searchPattern?: string;
    gmailIntegrationId?: string;
    gmailMessageFrom?: string;
    resultType?: string;
  };
}

interface ConnectFileResponse {
  success: boolean;
  connectionId: string;
  alreadyConnected: boolean;
}

export const getPartnerReceiptHintsTool = tool(
  async ({ partnerId, transactionId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { hasHints: false, message: "User ID not provided" };
    }

    const db = await getDb();

    // Resolve partner from transaction if needed
    let resolvedPartnerId = partnerId;
    if (!resolvedPartnerId && transactionId) {
      const txDoc = await db.collection("transactions").doc(transactionId).get();
      if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        return { hasHints: false, message: "Transaction not found" };
      }
      resolvedPartnerId = txDoc.data()?.partnerId;
    }

    if (!resolvedPartnerId) {
      return { hasHints: false, message: "No partner assigned - skip hints" };
    }

    const partnerDoc = await db.collection("partners").doc(resolvedPartnerId).get();
    if (!partnerDoc.exists || partnerDoc.data()?.userId !== userId) {
      return { hasHints: false, message: "Partner not found" };
    }

    const partner = partnerDoc.data()!;
    const fileSourcePatterns: Array<{
      sourceType?: string;
      pattern?: string;
      resultType?: string;
      usageCount?: number;
      integrationId?: string;
      filenameExamples?: string[];
    }> = partner.fileSourcePatterns || [];
    const emailDomains: string[] = partner.emailDomains || [];
    const billingCycle = partner.billingCycle || null;

    const sortedPatterns = [...fileSourcePatterns].sort(
      (a, b) => (b.usageCount || 0) - (a.usageCount || 0)
    );

    const preferredSource = sortedPatterns[0]?.sourceType || null;
    const filenameExamples = Array.from(
      new Set(sortedPatterns.flatMap((p) => p.filenameExamples || []))
    ).slice(0, 5);

    const workingQueries = sortedPatterns
      .filter((p) => p.pattern)
      .map((p) => ({
        query: p.pattern as string,
        sourceType: p.sourceType || "gmail",
        resultType: p.resultType || null,
        usageCount: p.usageCount || 0,
        integrationId: p.integrationId || null,
      }))
      .slice(0, 5);

    return {
      hasHints: workingQueries.length > 0 || emailDomains.length > 0,
      partnerName: partner.name || null,
      preferredSource,
      workingQueries,
      emailDomains,
      filenameExamples,
      billingCycle: billingCycle ? {
        frequencyDays: billingCycle.frequencyDays ?? null,
        invoiceToTransactionDelay: billingCycle.invoiceToTransactionDelay ?? null,
      } : null,
      message:
        workingQueries.length > 0
          ? `Found ${workingQueries.length} working search pattern(s) for ${partner.name || "partner"}. Preferred source: ${preferredSource || "unknown"}`
          : emailDomains.length > 0
            ? `No search patterns yet, but known email domains: ${emailDomains.join(", ")}`
            : "No receipt search history for this partner yet",
    };
  },
  {
    name: "getPartnerReceiptHints",
    description: `Get receipt search hints for a partner based on past successful matches.
Returns: what source worked before (Gmail/local/browser), which search queries found receipts,
example filenames, known email domains, and billing cycle info.
Call this FIRST in receipt search - if hints exist, use the known-good query instead of generating new ones.`,
    schema: z.object({
      partnerId: z.string().optional().describe("Partner ID (if known)"),
      transactionId: z.string().optional().describe("Transaction ID (to look up partner)"),
    }),
  }
);

// ============================================================================
// Connect File to Transaction
// ============================================================================

/**
 * Helper to check if two names match (fuzzy comparison)
 */
function doNamesMatch(name1: string | null | undefined, name2: string | null | undefined): boolean {
  if (!name1 || !name2) return false;

  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/\s*(gmbh|ag|kg|ohg|ug|e\.?k\.?|inc\.?|ltd\.?|llc|co\.?)\s*/gi, " ")
      .replace(/[^a-z0-9\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  // Exact match after normalization
  if (n1 === n2) return true;

  // One contains the other
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Check for significant word overlap
  const words1 = n1.split(" ").filter((w) => w.length > 2);
  const words2 = n2.split(" ").filter((w) => w.length > 2);
  const matchingWords = words1.filter((w) =>
    words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w))
  );

  return matchingWords.length >= 1;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getFileAmountForValidation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  file: any,
  txAmount: number | null | undefined
): number | null {
  const extractedAmount = toFiniteNumber(file?.extractedAmount);
  const extractedVatAmount = toFiniteNumber(file?.extractedVatAmount);

  const lineItems = Array.isArray(file?.extractedLineItems) ? file.extractedLineItems : [];
  const lineAmountSum = lineItems.reduce((sum: number, item: unknown) => {
    const amount = toFiniteNumber((item as { amount?: unknown })?.amount);
    return amount === null ? sum : sum + amount;
  }, 0);
  const lineVatSum = lineItems.reduce((sum: number, item: unknown) => {
    const vatAmount = toFiniteNumber((item as { vatAmount?: unknown })?.vatAmount);
    return vatAmount === null ? sum : sum + vatAmount;
  }, 0);

  const candidates: number[] = [];
  if (extractedAmount !== null) {
    candidates.push(extractedAmount);
  }
  if (lineItems.length > 0) {
    candidates.push(lineAmountSum);
    candidates.push(lineAmountSum + lineVatSum);
  } else if (extractedAmount !== null && extractedVatAmount !== null) {
    candidates.push(extractedAmount + extractedVatAmount);
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueCandidates = Array.from(new Set(candidates.map((value) => Math.round(value))));
  const txAbs = txAmount != null ? Math.abs(txAmount) : null;

  if (txAbs != null) {
    return uniqueCandidates.reduce((best, candidate) =>
      Math.abs(candidate - txAbs) < Math.abs(best - txAbs) ? candidate : best
    );
  }

  return extractedAmount !== null ? extractedAmount : uniqueCandidates[0];
}

export const connectFileToTransactionTool = tool(
  async ({ fileId, transactionId, confidence, skipValidation, searchQuery, sourceType }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;

    if (!userId) {
      return { error: "User ID not provided" };
    }
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    const db = await getDb();

    // Verify file exists and belongs to user
    const fileDoc = await db.collection("files").doc(fileId).get();
    if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
      return { error: "File not found" };
    }

    // Verify transaction exists and belongs to user
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
      return { error: "Transaction not found" };
    }

    if (txDoc.data()?.quotaExceeded) {
      return { error: "Cannot connect files to over-quota transactions. This transaction exceeds the plan's transaction limit." };
    }

    const file = fileDoc.data()!;
    const tx = txDoc.data()!;

    // === VALIDATION: Check for mismatches before connecting ===
    if (!skipValidation) {
      const warnings: string[] = [];

      // 1. Amount validation - check if amounts are significantly different
      const fileAmount = getFileAmountForValidation(file, tx.amount); // in cents (best-effort gross)
      const txAmount = tx.amount; // in cents

      if (fileAmount != null && txAmount != null) {
        const absFileAmount = Math.abs(fileAmount);
        const absTxAmount = Math.abs(txAmount);

        if (absFileAmount > 0 && absTxAmount > 0) {
          const ratio = absFileAmount / absTxAmount;

          // Flag if amounts differ by more than 50% (ratio < 0.5 or > 2.0)
          if (ratio < 0.5 || ratio > 2.0) {
            const fileAmtStr = (absFileAmount / 100).toFixed(2);
            const txAmtStr = (absTxAmount / 100).toFixed(2);
            const fileCurrency = file.extractedCurrency || "EUR";
            const txCurrency = tx.currency || "EUR";

            warnings.push(
              `AMOUNT MISMATCH: File has ${fileAmtStr} ${fileCurrency} but transaction is ${txAmtStr} ${txCurrency} ` +
              `(${Math.round(ratio * 100)}% ratio). This file likely belongs to a different transaction.`
            );
          }
        }
      }

      // 2. Partner validation - check if file's extracted partner matches transaction
      const filePartner = file.extractedPartner;
      const txName = tx.name || tx.partner;

      if (filePartner && txName) {
        // Clean the transaction name (remove bank prefixes)
        const cleanTxName = txName
          .replace(/^(Tbl\*|To |From |SEPA |Überweisung |Lastschrift )/i, "")
          .replace(/\.{3}$/, "")
          .trim();

        if (!doNamesMatch(filePartner, cleanTxName)) {
          warnings.push(
            `PARTNER MISMATCH: File is from "${filePartner}" but transaction is "${cleanTxName}". ` +
            `This file may not belong to this transaction.`
          );
        }
      }

      // If there are warnings, return them instead of connecting
      if (warnings.length > 0) {
        return {
          error: "VALIDATION_FAILED",
          warnings,
          fileId,
          transactionId,
          fileName: file.fileName,
          extractedPartner: file.extractedPartner || null,
          extractedAmount: fileAmount != null ? fileAmount / 100 : null,
          extractedCurrency: file.extractedCurrency || "EUR",
          transactionName: tx.name,
          transactionAmount: tx.amount != null ? tx.amount / 100 : null,
          transactionCurrency: tx.currency || "EUR",
          message: `Cannot connect: ${warnings.join(" ")} Use skipValidation=true to force connection.`,
        };
      }
    }

    // Check if already connected
    const existingConnection = await db
      .collection("fileConnections")
      .where("fileId", "==", fileId)
      .where("transactionId", "==", transactionId)
      .where("userId", "==", userId)
      .get();

    if (!existingConnection.empty) {
      return {
        success: true,
        connectionId: existingConnection.docs[0].id,
        alreadyConnected: true,
        message: `File "${file.fileName}" was already connected to this transaction.`,
      };
    }

    const inferredSourceType = sourceType || (
      file.sourceType === "gmail_html_invoice"
        ? "gmail_email"
        : file.sourceType === "gmail" || file.sourceType === "gmail_invoice_link"
          ? "gmail_attachment"
          : file.sourceType === "browser"
            ? "browser"
            : "local"
    );

    const gmailMessageFrom = file.gmailSenderEmail || file.gmailMessageFrom || undefined;
    const gmailIntegrationId = file.gmailIntegrationId || undefined;
    const effectiveSearchPattern = searchQuery || file.sourceSearchPattern || undefined;
    const effectiveResultType =
      file.sourceResultType ||
      (inferredSourceType === "gmail_email"
        ? "gmail_html_invoice"
        : inferredSourceType === "gmail_attachment"
          ? "gmail_attachment"
          : inferredSourceType === "browser"
            ? "browser_invoice"
            : "local_file");

    const result = await callFirebaseFunction<ConnectFileRequest, ConnectFileResponse>(
      "connectFileToTransaction",
      {
        fileId,
        transactionId,
        connectionType: "manual",
        matchConfidence: confidence || null,
        sourceInfo: {
          sourceType: inferredSourceType,
          searchPattern: effectiveSearchPattern,
          gmailIntegrationId,
          gmailMessageFrom,
          resultType: effectiveResultType,
        },
      },
      authHeader
    );

    return {
      success: true,
      connectionId: result.connectionId,
      alreadyConnected: result.alreadyConnected,
      fileName: file.fileName,
      message: result.alreadyConnected
        ? `File "${file.fileName}" was already connected to this transaction.`
        : `Connected "${file.fileName}" to transaction.`,
    };
  },
  {
    name: "connectFileToTransaction",
    description:
      `Connect an existing local file to a transaction. Use when searchLocalFiles finds a good match.

IMPORTANT: This tool validates that the file matches the transaction before connecting:
- Amount must be within 50-200% of transaction amount
- File's extracted partner must match transaction name

If validation fails, the connection is blocked. Review the warnings before proceeding.
Only use skipValidation=true if you're certain the file belongs to this transaction despite the mismatch.`,
    schema: z.object({
      fileId: z.string().describe("The file ID from searchLocalFiles results"),
      transactionId: z.string().describe("The transaction ID to connect to"),
      confidence: z.number().optional().describe("Match confidence score (0-100)"),
      skipValidation: z.boolean().optional().describe("Set to true to skip amount/partner validation (use with caution)"),
      searchQuery: z
        .string()
        .optional()
        .describe("The search query that found this file"),
      sourceType: z
        .string()
        .optional()
        .describe("How file was found: local, gmail_attachment, gmail_email, browser"),
    }),
  }
);

// ============================================================================
// Export all search tools
// ============================================================================

export const SEARCH_TOOLS = [
  generateSearchSuggestionsTool,
  getPartnerReceiptHintsTool,
  searchLocalFilesTool,
  connectFileToTransactionTool,
  searchGmailAttachmentsTool,
  searchGmailEmailsTool,
  analyzeEmailTool,
];
