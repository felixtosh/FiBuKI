/**
 * Write Tools
 *
 * Tools that modify data. Some require user confirmation.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import {
  assignPartnerToFileTool,
  assignPartnerToTransactionTool,
  callableErrorMessage,
  createPartnerTool,
  createSourceTool,
  dismissSplitSuggestionTool,
  getCorrectionTool,
  getReceiptLinkTool,
  linkCorrectionTool,
  linkReceiptTool,
  makeFileTheOriginalTool,
  markFileAsCopyTool,
  splitFileTool,
  unlinkCorrectionTool,
  unlinkReceiptTool,
  unmarkFileAsCopyTool,
  updatePartnerTool,
  updateTransactionTool,
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

// ============================================================================
// Rollback Transaction
// ============================================================================

// The rollback is the server's (#616): rollbackTransaction restores only what
// an edit may write, through the same rules as update_transaction. Every write
// with an MCP twin (the Partner, Copy, Correction, Receipt Link and Split acts
// among them) wraps it in ./mcp-tools (#616, #665).

export const rollbackTransactionTool = tool(
  async ({ transactionId, historyId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }
    try {
      return await callFirebaseFunction<
        { transactionId: string; historyId: string },
        { success: boolean; transactionId: string; restoredValues: Record<string, unknown>; historyId: string | null }
      >("rollbackTransaction", { transactionId, historyId }, authHeader);
    } catch (err) {
      return { error: callableErrorMessage(err) };
    }
  },
  {
    name: "rollbackTransaction",
    description:
      "Rollback a transaction to a previous state from its history. REQUIRES USER CONFIRMATION.",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID"),
      historyId: z.string().describe("The history entry ID to rollback to"),
    }),
  }
);

// ============================================================================
// Match Transaction Partners (rule-based + agentic fallback)
// ============================================================================

export const matchTransactionPartnersTool = tool(
  async ({ transactionIds, matchAllUnassigned = false }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    if (!userId || !authHeader) {
      return { error: "User ID or auth header not provided" };
    }

    const normalizedIds = Array.isArray(transactionIds)
      ? Array.from(new Set(transactionIds.map((id) => id.trim()).filter(Boolean)))
      : [];

    if (!matchAllUnassigned && normalizedIds.length === 0) {
      return { error: "Provide transactionIds or set matchAllUnassigned=true" };
    }

    if (normalizedIds.length > 250) {
      return {
        error: "Too many transaction IDs. Provide up to 250 IDs per call or use matchAllUnassigned.",
      };
    }

    const db = await getDb();
    let payload: { transactionIds?: string[]; matchAll?: boolean };
    let precheck:
      | {
          requestedCount: number;
          ownedCount: number;
          eligibleCount: number;
          alreadyMatchedCount: number;
          skippedNoReceiptCategoryCount: number;
          skippedQuotaExceededCount: number;
        }
      | null = null;

    if (normalizedIds.length > 0) {
      const docs = await Promise.all(
        normalizedIds.map((id) => db.collection("transactions").doc(id).get())
      );
      const ownedDocs = docs.filter((doc) => doc.exists && doc.data()?.userId === userId);

      const eligibleIds: string[] = [];
      let alreadyMatchedCount = 0;
      let skippedNoReceiptCategoryCount = 0;
      let skippedQuotaExceededCount = 0;

      for (const doc of ownedDocs) {
        const data = doc.data()!;
        if (data.partnerId) {
          alreadyMatchedCount += 1;
          continue;
        }
        if (data.noReceiptCategoryId) {
          skippedNoReceiptCategoryCount += 1;
          continue;
        }
        if (data.quotaExceeded) {
          skippedQuotaExceededCount += 1;
          continue;
        }
        eligibleIds.push(doc.id);
      }

      precheck = {
        requestedCount: normalizedIds.length,
        ownedCount: ownedDocs.length,
        eligibleCount: eligibleIds.length,
        alreadyMatchedCount,
        skippedNoReceiptCategoryCount,
        skippedQuotaExceededCount,
      };

      if (eligibleIds.length === 0) {
        return {
          success: true,
          scope: "selected_transactions",
          ...precheck,
          processed: 0,
          autoMatched: 0,
          withSuggestions: 0,
          unchangedCount: 0,
          message:
            alreadyMatchedCount > 0
              ? `Already matched ${alreadyMatchedCount} selected transaction(s). No additional unmatched transactions were eligible.`
              : "No eligible unmatched transactions in the selected set.",
        };
      }

      payload = {
        transactionIds: eligibleIds,
        matchAll: false,
      };
    } else {
      payload = {
        matchAll: false,
      };
    }

    const result = await callFirebaseFunction<
      { transactionIds?: string[]; matchAll?: boolean },
      { processed: number; autoMatched: number; withSuggestions: number }
    >("matchPartners", payload, authHeader);

    const actionableCount = (result.autoMatched || 0) + (result.withSuggestions || 0);
    const unchangedCount = Math.max(0, (result.processed || 0) - actionableCount);

    return {
      success: true,
      scope: normalizedIds.length > 0 ? "selected_transactions" : "all_unassigned",
      ...(precheck ? precheck : {}),
      processed: result.processed || 0,
      autoMatched: result.autoMatched || 0,
      withSuggestions: result.withSuggestions || 0,
      unchangedCount,
      message:
        normalizedIds.length > 0 && precheck
          ? `Processed ${result.processed || 0} unmatched transaction(s) from the selected set (${precheck.alreadyMatchedCount} already matched).`
          : `Processed ${result.processed || 0} unassigned transaction(s) for partner matching.`,
    };
  },
  {
    name: "matchTransactionPartners",
    description: `Run partner matching for transactions (rule-based + agentic fallback workers).

Use this for "match transactions/invoices in a timeframe" flows:
- First use listTransactions (date/search filters) to pick target IDs
- Then call this tool with those transaction IDs

If called with transactionIds, it returns how many were already matched vs eligible.
If called with matchAllUnassigned=true, it processes all currently unassigned transactions.`,
    schema: z.object({
      transactionIds: z
        .array(z.string())
        .optional()
        .describe("Specific transaction IDs to process (recommended for timeframe-based matching)"),
      matchAllUnassigned: z
        .boolean()
        .optional()
        .describe("Process all currently unassigned transactions"),
    }),
  }
);

// ============================================================================
// Bulk Update Transactions (description / completion / partner / no-receipt category)
// ============================================================================

interface BulkUpdateTransactionsResponse {
  success: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

export const bulkUpdateTransactionsTool = tool(
  async (
    {
      transactionIds,
      description,
      isComplete,
      partnerId,
      noReceiptCategoryId,
      noReceiptCategoryTemplateId,
      clearNoReceiptCategory,
    },
    config
  ) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }
    if (!transactionIds || transactionIds.length === 0) {
      return { error: "No transaction IDs provided" };
    }
    if (transactionIds.length > 1000) {
      return { error: "Cannot update more than 1000 transactions at once" };
    }

    const data: Record<string, unknown> = {};
    if (description !== undefined) data.description = description;
    if (isComplete !== undefined) data.isComplete = isComplete;
    if (partnerId !== undefined) {
      // Like every tool here, a user Partner: the callable refuses one that
      // is not the caller's.
      data.partnerId = partnerId;
      data.partnerType = "user";
      data.partnerMatchedBy = "ai";
    }
    if (clearNoReceiptCategory) {
      data.noReceiptCategoryId = null;
      data.noReceiptCategoryTemplateId = null;
    } else {
      if (noReceiptCategoryId !== undefined) data.noReceiptCategoryId = noReceiptCategoryId;
      if (noReceiptCategoryTemplateId !== undefined) data.noReceiptCategoryTemplateId = noReceiptCategoryTemplateId;
      if (data.noReceiptCategoryId || data.noReceiptCategoryTemplateId) {
        data.noReceiptCategoryMatchedBy = "manual";
      }
    }

    if (Object.keys(data).length === 0) {
      return { error: "No update fields provided" };
    }

    const result = await callFirebaseFunction<
      { ids: string[]; data: typeof data; actor: "ai" },
      BulkUpdateTransactionsResponse
    >("bulkUpdateTransactions", { ids: transactionIds, data, actor: "ai" }, authHeader);

    // Not "success" when nothing was updated: the chat showed a green
    // "completed" for nine "Not found" rows.
    return {
      success: result.success > 0 || result.failed === 0,
      updatedCount: result.success,
      failedCount: result.failed,
      failed: result.failed > 0 ? result.errors : undefined,
      message:
        `Updated ${result.success} transaction(s)${result.failed > 0 ? `, ${result.failed} failed` : ""}.` +
        (result.failed > 0
          ? " Tell the user. For \"Not found\", use the exact id values from listTransactions; never construct ids."
          : ""),
    };
  },
  {
    name: "bulkUpdateTransactions",
    description:
      "Bulk-update many transactions (description, completion, partner assignment, or no-receipt category). Use after listTransactions has shown the user the candidate rows and they have confirmed the change. Pass clearNoReceiptCategory=true to remove an existing category (e.g. flipping 'private' → needs receipt). Requires user confirmation.",
    schema: z.object({
      transactionIds: z
        .array(z.string())
        .min(1)
        .describe("Transaction IDs to update (max 1000): the exact id values from listTransactions"),
      description: z.string().optional().describe("New description for all selected transactions"),
      isComplete: z.boolean().optional().describe("Mark all as complete/incomplete"),
      partnerId: z.string().optional().describe("Assign this partner to all selected transactions"),
      noReceiptCategoryId: z
        .string()
        .optional()
        .describe("Assign this user no-receipt category (use the id from listCategories)"),
      noReceiptCategoryTemplateId: z
        .enum([
          "bank-fees",
          "interest",
          "bank-rewards",
          "internal-transfers",
          "payment-provider-settlements",
          "taxes-government",
          "payroll",
          "private-personal",
          "zero-value",
          "receipt-lost",
        ])
        .optional()
        .describe("Optional: also set/update the template ID for clarity (kept in sync with the category id)"),
      clearNoReceiptCategory: z
        .boolean()
        .optional()
        .describe("Set true to remove the no-receipt category (e.g. flipping 'private' transactions back to 'needs receipt')"),
    }),
  }
);

// ============================================================================
// Export all write tools
// ============================================================================

export const WRITE_TOOLS = [
  updateTransactionTool,
  createSourceTool,
  rollbackTransactionTool,
  assignPartnerToTransactionTool,
  assignPartnerToFileTool,
  markFileAsCopyTool,
  unmarkFileAsCopyTool,
  makeFileTheOriginalTool,
  linkCorrectionTool,
  unlinkCorrectionTool,
  getCorrectionTool,
  linkReceiptTool,
  unlinkReceiptTool,
  getReceiptLinkTool,
  splitFileTool,
  dismissSplitSuggestionTool,
  bulkUpdateTransactionsTool,
  matchTransactionPartnersTool,
  createPartnerTool,
  updatePartnerTool,
];
