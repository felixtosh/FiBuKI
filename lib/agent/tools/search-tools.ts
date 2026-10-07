/**
 * Search Tools
 *
 * Tools for searching files and receipts across local files and Gmail.
 */

import { toDateSafe } from "@/lib/utils";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { classifyEmail } from "@/lib/email-providers/interface";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { TRANSACTION_MATCH_CONFIG } from "@/types/transaction-matching";
// The one reader of a file's dismissal fields (fork #94), imported rather than
// re-derived here — a fourth hand-rolled reader of the same two fields is how
// the enforcement drifts apart again. Dependency-free pure logic; the relative
// path across the package boundary mirrors lib/selfhost/firestore-admin-shim.
import { readDismissedTransactionIds } from "../../../functions/src/matching/dismissedTransactions";
// The File amount the agent's connect compares (#665): the shared connect
// handler's checks own it, and searchLocalFiles reports the same figure.
// Dependency-free, like the import above.
import { getFileAmountForValidation } from "../../../functions/src/tools/agentConnectChecks";
// The chat's connect wraps its MCP twin (#665).
import { connectFileToTransactionTool } from "./mcp-tools";
import { NO_MAILBOX_CONNECTED, chatMailIntegrations } from "./mail-integrations";

// Lazy-load admin DB to avoid initialization at build time
let _db: ReturnType<typeof import("@/lib/firebase/admin").getAdminDb> | null = null;
async function getDb() {
  if (!_db) {
    const { getAdminDb } = await import("@/lib/firebase/admin");
    _db = getAdminDb();
  }
  return _db;
}

/**
 * Which of these files currently reject this transaction (fork #101).
 *
 * Dismissal lives on the file document, so a caller holding only ids has to
 * read them. searchLocalFiles does not use this — it already holds every file
 * document and filters in memory. This is for the paths that hold an id and
 * nothing else: Gmail attachments matched to an already-downloaded file, and
 * the connect tools.
 *
 * A `dismissedTransactionIds array-contains` query would answer this in one
 * round trip, but it would also be a fourth place that assumes the legacy array
 * is the authoritative shape. Reading the documents and asking
 * readDismissedTransactionIds keeps one reader for both stored shapes; the id
 * lists here are short (candidates already downloaded, or one pair).
 */
async function dismissedFileIdsFor(
  db: Awaited<ReturnType<typeof getDb>>,
  fileIds: string[],
  transactionId: string,
  userId: unknown
): Promise<Set<string>> {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length === 0) return new Set<string>();

  const snaps = await Promise.all(
    unique.map((id) => db.collection("files").doc(id).get())
  );

  const dismissed = new Set<string>();
  for (const snap of snaps) {
    // Only the caller's own files: another user's rejections are their data.
    if (!snap.exists || !userId || snap.data()?.userId !== userId) continue;
    if (readDismissedTransactionIds(snap.data()).has(transactionId)) {
      dismissed.add(snap.id);
    }
  }
  return dismissed;
}

/** What findFileMatchesForTransaction answers: the matcher's ranking of stored Files (#613). */
interface FileMatchesResponse {
  matches: Array<{ fileId: string; confidence: number; matchSources: string[] }>;
  totalCandidates: number;
  rejectedFileIds: string[];
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
    /**
     * The Transaction being scored against. The server derives Coverage from
     * it (#239); nothing about the Remainder is computed on this side.
     */
    id?: string | null;
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
    /** Scored against the Transaction's Remainder — suggestion only (#239). */
    scoredAgainstRemainder?: boolean;
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
    const txDate = toDateSafe(tx.date) || new Date(tx.date);

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
    const txDate = toDateSafe(tx.date) || new Date(tx.date);

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

    if (tx.partnerId) {
      const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
      if (partnerDoc.exists) {
        const partnerData = partnerDoc.data()!;

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

    // The matcher ranks the stored Files (#613), through the Connect File
    // window's own callable: the scorer the trigger stores suggestions with,
    // and its eligibility rule (no deleted Files, Copies, non-invoices or
    // Files addressed to someone else; no rejected pair or over-quota
    // Transaction) and date window. A rejected pair is never offered back:
    // the agent has no other way to know it was refused (fork #101).
    let ranked: FileMatchesResponse;
    try {
      ranked = await callFirebaseFunction<{ transactionId: string; limit: number }, FileMatchesResponse>(
        "findFileMatchesForTransaction",
        { transactionId, limit: 100 },
        authHeader
      );
    } catch (err) {
      console.error("[searchLocalFiles] Error scoring files:", err);
      return {
        searchType: "local_files",
        amountsIn: "cents",
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
    const dismissedForThisTransaction = ranked.rejectedFileIds.length;

    if (ranked.totalCandidates === 0) {
      // Build hint if partner prefers no-receipt
      let resolutionHint: string | undefined;
      if (partnerContext?.resolution?.type === "no_receipt") {
        resolutionHint = `Partner "${partnerContext.name}" typically doesn't need receipts. Consider suggesting the "${partnerContext.resolution.preferredNoReceiptCategory || "no-receipt"}" category.`;
      }

      return {
        searchType: "local_files",
        amountsIn: "cents",
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
        dismissedForThisTransaction,
        // Says which of the two "nothing to offer" cases this is. Without it an
        // agent reads "no files" and re-uploads or re-searches for a document
        // that is already here and was deliberately refused.
        summary: dismissedForThisTransaction > 0
          ? `No uploaded files available to search — ${dismissedForThisTransaction} were previously rejected for this transaction and are not offered again.${resolutionHint ? ` ${resolutionHint}` : ""}`
          : resolutionHint
            ? `No uploaded files available. ${resolutionHint}`
            : "No uploaded files available to search",
        candidates: [],
        totalFound: 0,
      };
    }

    // The ranked Files' own records, for what the agent is shown.
    const ranks = ranked.matches.filter((m) => m.confidence > 0);
    const fileSnaps = ranks.length
      ? await db.getAll(...ranks.map((m) => db.collection("files").doc(m.fileId)))
      : [];
    const fileById = new Map(fileSnaps.filter((d) => d.exists).map((d) => [d.id, d.data()!]));

    const candidates: Array<{
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
      connectedElsewhere: boolean;
    }> = [];

    for (const match of ranks) {
      const file = fileById.get(match.fileId);
      if (!file) continue;

      // Strategy filters read the matcher's Match Sources.
      if (strategy === "partner_files" && !match.matchSources.includes("partner")) continue;
      if (strategy === "amount_files" && !match.matchSources.some((s) => s.startsWith("amount"))) continue;

      const candidateAmount = getFileAmountForValidation(file, tx.amount);
      candidates.push({
        id: `local_${match.fileId}`,
        sourceType: "local_file",
        score: match.confidence,
        scoreLabel:
          match.confidence >= TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD
            ? "Strong"
            : match.confidence >= TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD
              ? "Likely"
              : null,
        scoreReasons: match.matchSources,
        fileId: match.fileId,
        fileName: file.fileName,
        // Integer cents, as every amount the chat reads (#616).
        extractedAmount: candidateAmount ?? undefined,
        extractedCurrency: file.extractedCurrency || "EUR",
        extractedDate: toDateSafe(file.extractedDate)?.toISOString() ?? undefined,
        extractedPartner: file.extractedPartner ?? undefined,
        // A File can belong to more than one Transaction; say so.
        connectedElsewhere: Array.isArray(file.transactionIds) && file.transactionIds.length > 0,
      });
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
      // Every amount here is integer cents (#616); a result saved before said euros.
      amountsIn: "cents",
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
      dismissedForThisTransaction,
      summary:
        (candidates.length > 0
          ? `Found ${candidates.length} files. Top match: "${topCandidates[0]?.fileName}" (${topCandidates[0]?.score}%)`
          : resolutionHint
            ? `No matching files found. ${resolutionHint}`
            : "No matching files found") +
        (dismissedForThisTransaction > 0
          ? ` ${dismissedForThisTransaction} file${dismissedForThisTransaction === 1 ? " was" : "s were"} previously rejected for this transaction and ${dismissedForThisTransaction === 1 ? "is" : "are"} not offered.`
          : ""),
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
      "Search uploaded files that might match a transaction. Scores files by amount, date, and partner match. Returns candidates with scores. Amounts are integer cents: each candidate's extractedAmount (unsigned document total) and searchedTransaction.amount (negative = expense).",
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
    const workerType = config?.configurable?.workerType as string | undefined;

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
    const txDate = toDateSafe(tx.date) || new Date(tx.date);
    const rejectedFileIds = new Set<string>(tx.rejectedFileIds || []);
    const receiptWorkerDateFrom = new Date(txDate);
    receiptWorkerDateFrom.setDate(receiptWorkerDateFrom.getDate() - 180);
    const receiptWorkerDateTo = new Date(txDate);
    receiptWorkerDateTo.setDate(receiptWorkerDateTo.getDate() + 45);

    // Get partner info if available
    let partner = null;
    if (tx.partnerId) {
      const partnerDoc = await db.collection("partners").doc(tx.partnerId).get();
      if (partnerDoc.exists) {
        partner = partnerDoc.data();
      }
    }

    // Every Mail Integration the receipt search reads, Gmail and IMAP alike (#746)
    const mailboxes = await chatMailIntegrations(db, userId);

    if (mailboxes.connected.length === 0) {
      return {
        searchType: "gmail_attachments",
        gmailNotConnected: true,
        error: NO_MAILBOX_CONNECTED,
        candidates: [],
        queriesUsed: query ? [query] : [],
        totalFound: 0,
        integrationCount: 0,
      };
    }

    // Mailboxes waiting for new credentials are reported, not searched
    const integrationsNeedingReauth = mailboxes.needingReauth;

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
      /** True if this file was explicitly rejected for this transaction before */
      isRejected?: boolean;
    }> = [];

    for (const integration of mailboxes.searched) {
      console.log("[searchGmailAttachments] Searching integration:", integration.email);

      for (const searchQuery of searchQueries) {
        try {
          // Call searchGmailCallable directly (same as UI does)
          // In receipt worker mode, constrain by a broad default window to reduce stale noise.
          const searchResponse = await callFirebaseFunction<SearchGmailRequest, SearchGmailResponse>(
            "searchGmailCallable",
            {
              integrationId: integration.id,
              query: searchQuery,
              ...(workerType === "receipt_search"
                ? {
                    dateFrom: receiptWorkerDateFrom.toISOString(),
                    dateTo: receiptWorkerDateTo.toISOString(),
                  }
                : {}),
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
                integrationId: integration.id,
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
                integrationId: integration.id,
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
                    // The server derives Coverage from the id (#239).
                    id: transactionId,
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
                    isRejected: att._existingFileId ? rejectedFileIds.has(att._existingFileId) : false,
                  });
                }
              }
            } catch (scoreErr) {
              console.error("[searchGmailAttachments] Error scoring attachments:", scoreErr);
            }
          }
        } catch (err) {
          console.error(
            `[searchGmailAttachments] Error searching integration ${integration.id}:`,
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

    // Drop candidates whose already-downloaded file has rejected this
    // transaction (fork #101). Only those can be dismissed: an attachment that
    // is not a file yet has no document to carry the rejection. Without this,
    // the pair a human refused comes straight back as a Gmail candidate and is
    // connected by id on the next turn.
    const dismissedExistingFileIds = await dismissedFileIdsFor(
      db,
      dedupedCandidates
        .map((c) => c.existingFileId)
        .filter((id): id is string => Boolean(id)),
      transactionId,
      userId
    );
    const offerableCandidates = dedupedCandidates.filter(
      (c) => !(c.existingFileId && dismissedExistingFileIds.has(c.existingFileId))
    );
    const dismissedForThisTransaction =
      dedupedCandidates.length - offerableCandidates.length;

    const topCandidates = offerableCandidates.slice(0, 15);
    const alreadyDownloadedCount = offerableCandidates.filter((c) => c.alreadyDownloaded).length;

    // Build summary
    let summary: string;
    if (offerableCandidates.length > 0) {
      const topInfo = `Top: "${topCandidates[0]?.attachmentFilename || topCandidates[0]?.emailSubject}" (${topCandidates[0]?.score}%)`;
      const downloadedInfo = alreadyDownloadedCount > 0
        ? ` (${alreadyDownloadedCount} already downloaded)`
        : "";
      summary = `Searched "${searchQueries.join('", "')}" - Found ${offerableCandidates.length} attachments${downloadedInfo}. ${topInfo}`;
    } else {
      summary = `Searched "${searchQueries.join('", "')}" - No attachments found`;
    }
    if (dismissedForThisTransaction > 0) {
      summary += ` ${dismissedForThisTransaction} already-downloaded attachment${dismissedForThisTransaction === 1 ? " was" : "s were"} previously rejected for this transaction and ${dismissedForThisTransaction === 1 ? "is" : "are"} not offered.`;
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
      ...(workerType === "receipt_search"
        ? {
            appliedDateWindow: {
              from: receiptWorkerDateFrom.toISOString(),
              to: receiptWorkerDateTo.toISOString(),
              reason: "receipt_search default window (txDate -180d to +45d)",
            },
          }
        : {}),
      queriesUsed: searchQueries,
      summary,
      candidates: topCandidates.map((c) => ({
        ...c,
        scoreDetails: `${c.score}% - ${c.scoreReasons?.join(", ") || "no reasons"}`,
      })),
      totalFound: offerableCandidates.length,
      dismissedForThisTransaction,
      alreadyDownloadedCount,
      integrationCount: mailboxes.connected.length,
      integrationsNeedingReauth: integrationsNeedingReauth.length > 0 ? integrationsNeedingReauth : undefined,
    };
  },
  {
    name: "searchGmailAttachments",
    description: `Search every connected mailbox (Gmail or IMAP) for email attachments that might be receipts for a transaction.

Returns candidates with scores. Each candidate includes:
- alreadyDownloaded: true if this attachment was previously downloaded
- existingFileId: the file ID if already downloaded (can be connected directly)

If a high-scoring candidate is alreadyDownloaded, use connectFileToTransaction with existingFileId.
If not downloaded, use downloadGmailAttachment to download it first, passing the candidate's integrationId.`,
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
    const workerType = config?.configurable?.workerType as string | undefined;

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

    // In receipt worker mode, use a broad transaction-relative window by default
    // unless caller already provided explicit date filters.
    let effectiveDateFrom = dateFrom;
    let effectiveDateTo = dateTo;
    if (workerType === "receipt_search" && tx?.date && !effectiveDateFrom && !effectiveDateTo) {
      const txDate = toDateSafe(tx.date) || new Date(tx.date);
      const defaultFrom = new Date(txDate);
      defaultFrom.setDate(defaultFrom.getDate() - 180);
      const defaultTo = new Date(txDate);
      defaultTo.setDate(defaultTo.getDate() + 45);
      effectiveDateFrom = defaultFrom.toISOString();
      effectiveDateTo = defaultTo.toISOString();
    }

    // Every Mail Integration the receipt search reads, Gmail and IMAP alike (#746)
    const mailboxes = await chatMailIntegrations(db, userId);

    if (mailboxes.connected.length === 0) {
      return {
        searchType: "gmail_emails",
        query: query || "",
        gmailNotConnected: true,
        error: NO_MAILBOX_CONNECTED,
        emails: [],
        totalFound: 0,
        integrationCount: 0,
      };
    }

    // Mailboxes waiting for new credentials are reported, not searched
    const integrationsNeedingReauth = mailboxes.needingReauth;

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

    for (const integration of mailboxes.searched) {

      try {
        const searchResponse = await callFirebaseFunction<SearchGmailRequest, SearchGmailResponse>(
          "searchGmailCallable",
          {
            integrationId: integration.id,
            query,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo,
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
            integrationId: integration.id,
            integrationEmail: integration.email,
            attachmentCount: message.attachments?.length || 0,
            classification,
          });
        }
      } catch (err) {
        console.error(`[searchGmailEmails] Error searching integration ${integration.id}:`, err);
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
        const txDate = toDateSafe(tx.date) || new Date(tx.date);
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
              // The server derives Coverage from the id (#239). Non-null here:
              // `tx` is only set when a transactionId was given and resolved.
              id: transactionId,
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

    const mailInvoiceCount = resultEmails.filter((e) => e.classification.possibleMailInvoice).length;
    const invoiceLinkCount = resultEmails.filter((e) => e.classification.possibleInvoiceLink).length;
    const needsEmailAnalysis = workerType === "receipt_search" &&
      resultEmails.some((e) => e.classification.possibleMailInvoice || e.classification.possibleInvoiceLink);
    const recommendedAnalyzeCandidates = workerType === "receipt_search"
      ? resultEmails
        .filter((e) => e.classification.possibleMailInvoice || e.classification.possibleInvoiceLink)
        .slice(0, 3)
        .map((e) => ({
          messageId: e.messageId,
          integrationId: e.integrationId,
          subject: e.subject,
          from: e.from,
          score: e.score,
          reason: e.classification.possibleMailInvoice
            ? "possibleMailInvoice"
            : "possibleInvoiceLink",
        }))
      : [];

    const baseSummary = resultEmails.length > 0
      ? `Found ${dedupedEmails.length} emails for "${query}". ${mailInvoiceCount} may be mail invoices, ${invoiceLinkCount} may have invoice links.`
      : `No emails found for "${query}"`;
    const receiptModeHint = needsEmailAnalysis
      ? " In receipt_search mode: analyze top candidates with analyzeEmail before concluding no match."
      : "";

    return {
      searchType: "gmail_emails",
      query,
      emails: resultEmails,
      totalFound: dedupedEmails.length,
      integrationCount: mailboxes.connected.length,
      ...(needsEmailAnalysis
        ? {
            nextStep: "Run analyzeEmail on recommendedAnalyzeCandidates, then convertEmailToPdf if invoice-like.",
            recommendedAnalyzeCandidates,
          }
        : {}),
      ...(effectiveDateFrom || effectiveDateTo
        ? {
            appliedDateWindow: {
              from: effectiveDateFrom || null,
              to: effectiveDateTo || null,
            },
          }
        : {}),
      integrationsNeedingReauth: integrationsNeedingReauth.length > 0 ? integrationsNeedingReauth : undefined,
      summary: `${baseSummary}${receiptModeHint}`,
    };
  },
  {
    name: "searchGmailEmails",
    description:
      "Search every connected mailbox (Gmail or IMAP) for emails matching a query. Returns emails with classification (mail invoice, invoice link, attachments). Use to find order confirmations, booking receipts, or emails with invoice download links.",
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
  async ({ messageId, integrationId, transactionId }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    const workerType = config?.configurable?.workerType as string | undefined;

    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();

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
        messageId,
        integrationId,
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
    const shouldConvertToPdf = result.isMailInvoice ||
      result.mailInvoiceConfidence >= 0.4 ||
      (workerType === "receipt_search" && result.hasInvoiceLink && result.mailInvoiceConfidence >= 0.25);
    const recommendedAction = shouldConvertToPdf
      ? "convertEmailToPdf"
      : result.hasInvoiceLink
        ? "reportInvoiceLinks"
        : "continueSearch";

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
      shouldConvertToPdf,
      recommendedAction,
      nextStep: shouldConvertToPdf
        ? "Run convertEmailToPdf for this message, then waitForFileExtraction and validate against transaction."
        : result.hasInvoiceLink
          ? "If no better candidates exist, share invoice links as fallback."
          : "Analyze another email candidate or continue searching.",
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
      "Use AI to deeply analyze an email for invoice content. Determines if the email body IS an invoice, or if it contains links to download an invoice. Returns extracted URLs and confidence scores. messageId MUST be copied verbatim from a prior searchGmailEmails/searchGmailAttachments result — never invent or paraphrase it.",
    schema: z.object({
      messageId: z.string().describe("Message ID — must be copied verbatim from a prior searchGmailEmails result (e.g. '19e887bfc6749b98'). Do NOT invent placeholder IDs."),
      integrationId: z.string().optional().describe("The result's integrationId — copy it from the same search result. Required for a mailbox that is not Gmail (IMAP)"),
      transactionId: z.string().optional().describe("Transaction ID for context (improves accuracy)"),
    }),
  }
);

// ============================================================================
// Get Partner Receipt Hints
// ============================================================================

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
    // yazzbert/FiBuKI-selfhost#165: billingCycle is now {learned, declared,
    // effective}; this tool wants a flat cycle, so it reads the first
    // effective recurrence (band-aware search is #169).
    const billingCycle = partner.billingCycle?.effective?.[0] || null;

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
// Workflow Tool — findReceiptForTransaction
// ============================================================================
// Encodes the entire receipt-finding strategy (local + Gmail search, scoring,
// auto-connect-if-clear-winner) as a single Cloud Function call. Prefer this
// over composing generateSearchSuggestions/searchLocalFiles/searchGmail*/score
// manually — the workflow runs the same logic deterministically in <2s and is
// callable identically from chat, MCP, and external agents.

interface FindReceiptCandidate {
  source: "local_file" | "gmail_attachment" | "gmail_email";
  score: number;
  label: "Strong" | "Likely" | null;
  reasons: string[];
  fileId?: string;
  messageId?: string;
  attachmentId?: string;
  integrationId?: string;
  filename?: string;
  emailSubject?: string;
  emailFrom?: string;
}

interface FindReceiptResponse {
  status: "connected" | "needs_review" | "no_match" | "skipped";
  skipReason?: "already_has_file" | "has_no_receipt_category" | "transaction_not_found";
  fileId?: string;
  confidence?: number;
  candidates?: FindReceiptCandidate[];
  sourcesChecked: { localFiles: number; gmailAttachments: number; gmailEmails: number };
}

export const findReceiptForTransactionTool = tool(
  async ({ transactionId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }
    const result = await callFirebaseFunction<
      { transactionId: string },
      FindReceiptResponse
    >("findReceiptForTransaction", { transactionId }, authHeader);

    // Add a nextStep hint so downstream models know what to do next without re-reading prose
    let nextStep: string;
    switch (result.status) {
      case "connected":
        nextStep = `Done — file ${result.fileId} attached at ${result.confidence}% confidence.`;
        break;
      case "needs_review":
        nextStep =
          "Show the top candidates to the user (or for the highest-scoring gmail_attachment, " +
          "call downloadGmailAttachment with its messageId+attachmentId+integrationId, then waitForFileExtraction, " +
          "then connectFileToTransaction).";
        break;
      case "no_match":
        nextStep = "Nothing scored high enough; tell the user no receipts found.";
        break;
      case "skipped":
        nextStep =
          result.skipReason === "already_has_file"
            ? "Transaction already has a receipt; nothing to do."
            : result.skipReason === "has_no_receipt_category"
              ? "Transaction is marked complete via a no-receipt category."
              : "Transaction not found.";
        break;
    }
    return { ...result, nextStep };
  },
  {
    name: "findReceiptForTransaction",
    description:
      "End-to-end receipt finder for a transaction. Searches local files + Gmail across all the user's integrations, scores every candidate, and auto-connects a clear stored-file winner (≥85%, the matcher's auto-connect line, with ≥10pt lead). Stored files carry the same confidence their suggestion list shows; Gmail candidates are never auto-connected. Otherwise returns top candidates for review. Single call replaces the older recipe of generateSearchSuggestions→searchLocalFiles→searchGmail*→analyzeEmail→score chain. transactionId MUST be a real database ID from listTransactions/getTransaction (not a placeholder).",
    schema: z.object({
      transactionId: z
        .string()
        .describe("The transaction ID — copy verbatim from a prior listTransactions/getTransaction result."),
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
  findReceiptForTransactionTool,
];
