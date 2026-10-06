/**
 * Write Tools
 *
 * Tools that modify data. Some require user confirmation.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { lookupCompany, lookupByVatId, callFirebaseFunction } from "@/lib/api/firebase-callable";
import {
  assignPartnerToFileTool,
  assignPartnerToTransactionTool,
  callableErrorMessage,
  createSourceTool,
  updatePartnerTool,
  updateTransactionTool,
} from "./mcp-tools";
import { getOwnedDoc } from "@/lib/auth/owned-doc";

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
 * The name of one of the caller's own user Partners, or null. These tools
 * always assign `partnerType: "user"`, and every user shares one database,
 * so a Partner id from the model is only read once it is known to be theirs.
 */
async function ownedPartnerName(partnerId: unknown, userId: unknown): Promise<string | null> {
  if (typeof userId !== "string" || !userId) return null;
  const snap = await getOwnedDoc(await getDb(), "partners", partnerId, userId);
  return snap ? ((snap.data()?.name as string) || "Unknown") : null;
}

// ============================================================================
// Rollback Transaction
// ============================================================================

// The rollback is the server's (#616): rollbackTransaction restores only what
// an edit may write, through the same rules as update_transaction. updateTransaction,
// createSource, assignPartnerToTransaction, assignPartnerToFile and updatePartner
// wrap their MCP twins in ./mcp-tools (#616, #665).

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
// Copy (#162, ADR-0010)
// ============================================================================

/** The three Copy acts are callables; the tools only relay them. */
async function relayCopyAct(
  name: "markFileAsCopy" | "unmarkFileAsCopy" | "makeFileTheOriginal",
  data: Record<string, string>,
  authHeader: string | undefined
): Promise<Record<string, unknown>> {
  if (!authHeader) return { error: "Auth header not provided" };
  try {
    return await callFirebaseFunction<Record<string, string>, Record<string, unknown>>(name, data, authHeader);
  } catch (err) {
    return { error: (err as Error).message || `Failed: ${name}` };
  }
}

export const markFileAsCopyTool = tool(
  async ({ fileId, originalFileId }, config) =>
    relayCopyAct("markFileAsCopy", { fileId, originalFileId }, config?.configurable?.authHeader),
  {
    name: "markFileAsCopy",
    description:
      "Record a file as a Copy of another file: a second File of the same invoice that arrived by another route (mailbox and a document system, or a mailed copy of an invoice the user issued). A Copy holds no transaction connection and is never proposed as a match; if it was connected, the connection moves to the original where the original lacks it. Also accepts a Copy suggestion. A receipt for the same charge as an invoice is NOT a Copy, nor is a payment reminder. Reversible with unmarkFileAsCopy.",
    schema: z.object({
      fileId: z.string().describe("The File that is the Copy"),
      originalFileId: z.string().describe("The File it is a Copy of"),
    }),
  }
);

export const unmarkFileAsCopyTool = tool(
  async ({ fileId }, config) =>
    relayCopyAct("unmarkFileAsCopy", { fileId }, config?.configurable?.authHeader),
  {
    name: "unmarkFileAsCopy",
    description:
      "Not a Copy: undo a Copy, or decline a Copy suggestion on a file. The pair is never suggested again. Undoing reconnects nothing; the file goes back to matching.",
    schema: z.object({
      fileId: z.string().describe("The File that is (or was suggested as) the Copy"),
    }),
  }
);

export const makeFileTheOriginalTool = tool(
  async ({ fileId }, config) =>
    relayCopyAct("makeFileTheOriginal", { fileId }, config?.configurable?.authHeader),
  {
    name: "makeFileTheOriginal",
    description:
      "Swap a Copy and its original: the given Copy becomes the original and takes over the transaction connections; the former original becomes its Copy.",
    schema: z.object({
      fileId: z.string().describe("The Copy to make the original"),
    }),
  }
);

// ============================================================================
// Invoice Corrections (#564, ADR-0010)
// ============================================================================

/** The correction acts are callables, as for MCP; the tools only relay them. */
async function relayCorrectionAct(
  name: "linkCorrection" | "unlinkCorrection" | "getCorrection",
  data: Record<string, string>,
  authHeader: string | undefined
): Promise<Record<string, unknown>> {
  if (!authHeader) return { error: "Auth header not provided" };
  try {
    return await callFirebaseFunction<Record<string, string>, Record<string, unknown>>(name, data, authHeader);
  } catch (err) {
    return { error: (err as Error).message || `Failed: ${name}` };
  }
}

export const linkCorrectionTool = tool(
  async ({ fileId, originalFileId }, config) =>
    relayCorrectionAct("linkCorrection", { fileId, originalFileId }, config?.configurable?.authHeader),
  {
    name: "linkCorrection",
    description:
      "Link an Invoice Correction (a supplier's credit note, a Gutschrift reducing an earlier invoice, a Rechnungskorrektur) to the File it corrects. The UVA then books the refund against the original's Vorsteuer (KZ 067) or revenue, at the original's rates; an unlinked correction blocks the period's filing. Also accepts a link suggestion. Reversible with unlinkCorrection.",
    schema: z.object({
      fileId: z.string().describe("The correction File (the credit note)"),
      originalFileId: z.string().describe("The File it corrects (the original invoice)"),
    }),
  }
);

export const unlinkCorrectionTool = tool(
  async ({ fileId, originalFileId }, config) =>
    relayCorrectionAct(
      "unlinkCorrection",
      originalFileId ? { fileId, originalFileId } : { fileId },
      config?.configurable?.authHeader
    ),
  {
    name: "unlinkCorrection",
    description:
      "Remove an Invoice Correction's link, or decline one of its link suggestions (pass originalFileId). That File is never linked to it automatically again.",
    schema: z.object({
      fileId: z.string().describe("The correction File"),
      originalFileId: z.string().optional().describe("The suggested File to decline; omit to remove the link"),
    }),
  }
);

export const getCorrectionTool = tool(
  async ({ fileId, transactionId }, config) =>
    relayCorrectionAct(
      "getCorrection",
      transactionId ? { transactionId } : { fileId: fileId ?? "" },
      config?.configurable?.authHeader
    ),
  {
    name: "getCorrection",
    description:
      "Inspect Invoice Corrections: for a File, what it corrects, who paid the original, its link suggestions and the corrections linked to it; for a transaction, the transactions related to it through a correction (a refund and the purchase it refunds).",
    schema: z.object({
      fileId: z.string().optional().describe("A correction or an original File"),
      transactionId: z.string().optional().describe("A refund or what it refunds"),
    }),
  }
);

// ============================================================================
// Receipt Links (#571, ADR-0012)
// ============================================================================

/** The Receipt Link acts are callables, as for MCP; the tools only relay them. */
async function relayReceiptLinkAct(
  name: "linkReceipt" | "unlinkReceipt" | "getReceiptLink",
  data: Record<string, string>,
  authHeader: string | undefined
): Promise<Record<string, unknown>> {
  if (!authHeader) return { error: "Auth header not provided" };
  try {
    return await callFirebaseFunction<Record<string, string>, Record<string, unknown>>(name, data, authHeader);
  } catch (err) {
    return { error: (err as Error).message || `Failed: ${name}` };
  }
}

export const linkReceiptTool = tool(
  async ({ fileId, invoiceFileId }, config) =>
    relayReceiptLinkAct("linkReceipt", { fileId, invoiceFileId }, config?.configurable?.authHeader),
  {
    name: "linkReceipt",
    description:
      "Link a Receipt (a payment confirmation: GitHub's or Stripe's receipt, a card terminal slip) to the invoice it pays. Both stay on the transaction and count once: the invoice's figures and Vorsteuer, the Receipt's surplus (a tip) as Trinkgeld without VAT. If one File is on a transaction and the other on none, the other follows. Also accepts a pairing suggestion. Reversible with unlinkReceipt.",
    schema: z.object({
      fileId: z.string().describe("The Receipt"),
      invoiceFileId: z.string().describe("The invoice it pays"),
    }),
  }
);

export const unlinkReceiptTool = tool(
  async ({ fileId, otherFileId }, config) =>
    relayReceiptLinkAct(
      "unlinkReceipt",
      otherFileId ? { fileId, otherFileId } : { fileId },
      config?.configurable?.authHeader
    ),
  {
    name: "unlinkReceipt",
    description:
      "Remove a Receipt Link, or decline a pairing suggestion (pass otherFileId). The pair is never linked or suggested automatically again. No transaction connection changes.",
    schema: z.object({
      fileId: z.string().describe("A File of the pair"),
      otherFileId: z
        .string()
        .optional()
        .describe("The other File: a suggested pair to decline, or a Receipt linked to fileId; omit to remove fileId's own link"),
    }),
  }
);

export const getReceiptLinkTool = tool(
  async ({ fileId }, config) => relayReceiptLinkAct("getReceiptLink", { fileId }, config?.configurable?.authHeader),
  {
    name: "getReceiptLink",
    description:
      "Inspect a File's Receipt Link: the invoice it is the Receipt of, or the Receipts linked to it, and its pairing suggestions.",
    schema: z.object({
      fileId: z.string().describe("A Receipt or an invoice File"),
    }),
  }
);

// ============================================================================
// Create Partner
// ============================================================================

export const createPartnerTool = tool(
  async ({ name, aliases, vatId, website, country }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    try {
      // Call Cloud Function
      const result = await callFirebaseFunction<
        { data: { name: string; aliases?: string[]; vatId?: string; website?: string; country?: string } },
        { success: boolean; partnerId: string }
      >(
        "createUserPartner",
        {
          data: {
            name: name.trim(),
            aliases: aliases || [],
            vatId: vatId || undefined,
            website: website || undefined,
            country: country || undefined,
          },
        },
        authHeader
      );

      return {
        success: true,
        partnerId: result.partnerId,
        name: name.trim(),
        message: `Created partner "${name.trim()}"`,
      };
    } catch (err) {
      const error = err as Error;
      return { error: error.message || "Failed to create partner" };
    }
  },
  {
    name: "createPartner",
    description:
      "Create a new partner (vendor/supplier). Include VAT ID and website if known.",
    schema: z.object({
      name: z.string().describe("Partner name"),
      aliases: z.array(z.string()).optional().describe("Alternative names"),
      vatId: z.string().optional().describe("VAT ID (e.g., DE123456789)"),
      website: z.string().optional().describe("Website URL"),
      country: z.string().optional().describe("Country code (e.g., DE, AT)"),
    }),
  }
);

// ============================================================================
// Bulk Assign Partner to Transactions
// ============================================================================

export const bulkAssignPartnerToTransactionsTool = tool(
  async ({ transactionIds, partnerId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    if (!transactionIds || transactionIds.length === 0) {
      return { error: "No transaction IDs provided" };
    }

    const partnerName = await ownedPartnerName(partnerId, config?.configurable?.userId);
    if (partnerName === null) {
      return { error: "Partner not found" };
    }

    // Call Cloud Function for each transaction (ensures pattern learning + receipt search triggers)
    const results = {
      success: [] as string[],
      failed: [] as { id: string; reason: string }[],
    };

    for (const txId of transactionIds) {
      try {
        await callFirebaseFunction<
          { transactionId: string; partnerId: string; partnerType: "user"; matchedBy: "ai" },
          { success: boolean }
        >(
          "assignPartnerToTransaction",
          { transactionId: txId, partnerId, partnerType: "user", matchedBy: "ai" },
          authHeader
        );
        results.success.push(txId);
      } catch (err) {
        const error = err as Error;
        results.failed.push({ id: txId, reason: error.message || "unknown error" });
      }
    }

    return {
      success: true,
      partnerId,
      partnerName,
      assignedCount: results.success.length,
      failedCount: results.failed.length,
      failed: results.failed.length > 0 ? results.failed : undefined,
      message: `Assigned partner "${partnerName}" to ${results.success.length} transaction(s)`,
    };
  },
  {
    name: "bulkAssignPartnerToTransactions",
    description:
      "Assign a partner to multiple transactions at once. Use this instead of calling assignPartnerToTransaction multiple times.",
    schema: z.object({
      transactionIds: z.array(z.string()).describe("Array of transaction IDs to assign"),
      partnerId: z.string().describe("The partner ID to assign to all transactions"),
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
// Find or Create Partner (with AI lookup and VAT validation)
// ============================================================================

export const findOrCreatePartnerTool = tool(
  async ({ nameOrUrl, transactionId }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    if (!userId || !authHeader) {
      return { error: "User ID or auth header not provided" };
    }

    const db = await getDb();

    const searchTerm = nameOrUrl.trim();
    const isUrl = searchTerm.includes(".") && !searchTerm.includes(" ");

    console.log(`[findOrCreatePartner] Searching for: ${searchTerm} (isUrl: ${isUrl})`);

    // Step 1: Search existing partners first (read-only, direct Firestore is fine)
    const searchLower = searchTerm.toLowerCase();
    const domain = isUrl ? searchTerm.replace(/^https?:\/\//, "").split("/")[0] : null;

    const partnersSnapshot = await db
      .collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get();

    // Check for existing partner by name, alias, website, or VAT
    for (const doc of partnersSnapshot.docs) {
      const p = doc.data();
      const nameMatch = p.name?.toLowerCase().includes(searchLower);
      const aliasMatch = p.aliases?.some((a: string) => a.toLowerCase().includes(searchLower));
      const websiteMatch = domain && p.website?.toLowerCase().includes(domain.toLowerCase());
      const vatMatch = p.vatId?.toLowerCase().replace(/\s/g, "") === searchLower.toUpperCase().replace(/\s/g, "");

      if (nameMatch || aliasMatch || websiteMatch || vatMatch) {
        console.log(`[findOrCreatePartner] Found existing partner: ${p.name}`);

        // Optionally assign to transaction via Cloud Function
        if (transactionId) {
          try {
            await callFirebaseFunction<
              { transactionId: string; partnerId: string; partnerType: "user"; matchedBy: "ai" },
              { success: boolean }
            >(
              "assignPartnerToTransaction",
              { transactionId, partnerId: doc.id, partnerType: "user", matchedBy: "ai" },
              authHeader
            );

            return {
              success: true,
              action: "found_and_assigned",
              partnerId: doc.id,
              partnerName: p.name,
              transactionId,
              message: `Found existing partner "${p.name}" and assigned to transaction`,
            };
          } catch (err) {
            console.error("[findOrCreatePartner] Assignment failed:", err);
          }
        }

        return {
          success: true,
          action: "found_existing",
          partnerId: doc.id,
          partnerName: p.name,
          vatId: p.vatId,
          website: p.website,
          country: p.country,
          message: `Found existing partner "${p.name}"`,
        };
      }
    }

    // Step 2: Look up company info via AI (Gemini with Google Search grounding)
    console.log(`[findOrCreatePartner] No existing partner found, looking up via AI...`);

    let companyInfo;
    try {
      if (isUrl) {
        companyInfo = await lookupCompany({ url: searchTerm }, authHeader);
      } else {
        companyInfo = await lookupCompany({ name: searchTerm }, authHeader);
      }
      console.log(`[findOrCreatePartner] AI lookup result:`, companyInfo);
    } catch (error) {
      console.error(`[findOrCreatePartner] AI lookup failed:`, error);
      companyInfo = { name: searchTerm };
    }

    // Step 3: Validate VAT if we have one
    let vatValidation;
    const vatId = companyInfo.vatId;
    if (vatId) {
      try {
        console.log(`[findOrCreatePartner] Validating VAT: ${vatId}`);
        vatValidation = await lookupByVatId(vatId, authHeader);
        console.log(`[findOrCreatePartner] VAT validation result:`, vatValidation);

        if (vatValidation.viesValid) {
          if (vatValidation.name && !companyInfo.name) companyInfo.name = vatValidation.name;
          if (vatValidation.address && !companyInfo.address) companyInfo.address = vatValidation.address;
          if (vatValidation.country && !companyInfo.country) companyInfo.country = vatValidation.country;
        }
      } catch (error) {
        console.error(`[findOrCreatePartner] VAT validation failed:`, error);
      }
    }

    // Step 4: Create the partner via Cloud Function
    const partnerName = companyInfo.name || searchTerm;

    let partnerId: string;
    try {
      // Format address object into string
    const addressStr = companyInfo.address
      ? [companyInfo.address.street, companyInfo.address.postalCode, companyInfo.address.city, companyInfo.address.country]
          .filter(Boolean)
          .join(", ")
      : undefined;

    const createResult = await callFirebaseFunction<
        { data: { name: string; aliases?: string[]; vatId?: string; website?: string; country?: string; address?: string } },
        { success: boolean; partnerId: string }
      >(
        "createUserPartner",
        {
          data: {
            name: partnerName.trim(),
            aliases: companyInfo.aliases || [],
            vatId: companyInfo.vatId || undefined,
            website: companyInfo.website || (isUrl ? domain : undefined) || undefined,
            country: companyInfo.country || undefined,
            address: addressStr || undefined,
          },
        },
        authHeader
      );
      partnerId = createResult.partnerId;
      console.log(`[findOrCreatePartner] Created partner: ${partnerName} (${partnerId})`);
    } catch (err) {
      const error = err as Error;
      return { error: error.message || "Failed to create partner" };
    }

    // Step 5: Optionally assign to transaction via Cloud Function
    if (transactionId) {
      try {
        await callFirebaseFunction<
          { transactionId: string; partnerId: string; partnerType: "user"; matchedBy: "ai" },
          { success: boolean }
        >(
          "assignPartnerToTransaction",
          { transactionId, partnerId, partnerType: "user", matchedBy: "ai" },
          authHeader
        );

        return {
          success: true,
          action: "created_and_assigned",
          partnerId,
          partnerName: partnerName.trim(),
          vatId: companyInfo.vatId || null,
          vatValid: vatValidation?.viesValid || null,
          website: companyInfo.website || (isUrl ? domain : null),
          country: companyInfo.country || null,
          transactionId,
          message: `Created partner "${partnerName.trim()}" and assigned to transaction`,
        };
      } catch (err) {
        console.error("[findOrCreatePartner] Assignment failed:", err);
        // Partner was created but assignment failed - still return success with partner info
      }
    }

    return {
      success: true,
      action: "created",
      partnerId,
      partnerName: partnerName.trim(),
      vatId: companyInfo.vatId || null,
      vatValid: vatValidation?.viesValid || null,
      website: companyInfo.website || (isUrl ? domain : null),
      country: companyInfo.country || null,
      message: `Created partner "${partnerName.trim()}"`,
    };
  },
  {
    name: "findOrCreatePartner",
    description: `Find an existing partner or create a new one with AI-powered company lookup and VAT validation.

This tool:
1. Searches your existing partners by name, website, or VAT ID
2. If not found, looks up company info via AI (Google Search grounding)
3. Validates VAT IDs with the official EU VIES service
4. Creates the partner with verified information
5. Optionally assigns the partner to a transaction

Use this when a user asks to "find", "create", or "identify" a partner for a transaction.
Accepts company names (e.g., "Netflix") or website URLs (e.g., "wienerlinien.at").`,
    schema: z.object({
      nameOrUrl: z
        .string()
        .describe("Company name (e.g., 'Netflix', 'Wiener Linien') or website URL (e.g., 'wienerlinien.at')"),
      transactionId: z
        .string()
        .optional()
        .describe("Transaction ID to assign the partner to (if provided)"),
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
      { ids: string[]; data: typeof data },
      BulkUpdateTransactionsResponse
    >("bulkUpdateTransactions", { ids: transactionIds, data }, authHeader);

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
// Split (#550)
// ============================================================================

export const splitFileTool = tool(
  async ({ fileId, ranges }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) return { error: "Auth header not provided" };
    try {
      return await callFirebaseFunction<
        { fileId: string; ranges: Array<{ from: number; to: number }> },
        Record<string, unknown>
      >("splitFile", { fileId, ranges }, authHeader);
    } catch (err) {
      return { error: (err as Error).message || "Failed: splitFile" };
    }
  },
  {
    name: "splitFile",
    description:
      "Split a PDF that holds several separately issued invoices or Receipts (an Amazon Marketplace order with one Rechnung or Quittung per seller) into one file per invoice or Receipt. The ranges cover every page exactly once, in order. Each part is extracted from scratch and connected to the original's transactions; the original is deleted, and can be restored only after its parts are deleted. Use the file's splitSuggestion for the ranges when it has one.",
    schema: z.object({
      fileId: z.string().describe("The file to split"),
      ranges: z
        .array(z.object({ from: z.number().int(), to: z.number().int() }))
        .min(2)
        .describe("The parts in page order: first and last page of each, 1-based and inclusive"),
    }),
  }
);

export const dismissSplitSuggestionTool = tool(
  async ({ fileId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) return { error: "Auth header not provided" };
    try {
      return await callFirebaseFunction<{ fileId: string }, Record<string, unknown>>(
        "dismissSplitSuggestion",
        { fileId },
        authHeader
      );
    } catch (err) {
      return { error: (err as Error).message || "Failed: dismissSplitSuggestion" };
    }
  },
  {
    name: "dismissSplitSuggestion",
    description:
      "Say a file is one document, not several: removes its splitSuggestion, and re-extraction never stores a new one. Use it when the suggestion is wrong, such as one invoice running over several pages. splitFile still splits the file by explicit ranges.",
    schema: z.object({
      fileId: z.string().describe("The file whose split suggestion is wrong"),
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
  bulkAssignPartnerToTransactionsTool,
  bulkUpdateTransactionsTool,
  matchTransactionPartnersTool,
  createPartnerTool,
  updatePartnerTool,
  findOrCreatePartnerTool,
];
