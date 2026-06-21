/**
 * Write Tools
 *
 * Tools that modify data. Some require user confirmation.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Timestamp } from "firebase-admin/firestore";
import { lookupCompany, lookupByVatId, callFirebaseFunction } from "@/lib/api/firebase-callable";

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
// Update Transaction
// ============================================================================

export const updateTransactionTool = tool(
  async ({ transactionId, description, isComplete }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const txRef = db.collection("transactions").doc(transactionId);
    const txDoc = await txRef.get();

    if (!txDoc.exists) {
      return { error: "Transaction not found" };
    }

    const txData = txDoc.data()!;
    if (txData.userId !== userId) {
      return { error: "Transaction not found" };
    }

    // Build update object
    const updates: Record<string, unknown> = {
      updatedAt: Timestamp.now(),
    };

    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    if (description !== undefined && description !== txData.description) {
      previousValues.description = txData.description;
      newValues.description = description;
      updates.description = description;
    }

    if (isComplete !== undefined && isComplete !== txData.isComplete) {
      previousValues.isComplete = txData.isComplete;
      newValues.isComplete = isComplete;
      updates.isComplete = isComplete;
    }

    if (Object.keys(newValues).length === 0) {
      return {
        success: true,
        message: "No changes to apply",
        transactionId,
      };
    }

    // Create history entry
    const historyRef = txRef.collection("history").doc();
    await historyRef.set({
      changedAt: Timestamp.now(),
      changedBy: userId,
      previousValues,
      newValues,
    });

    // Apply updates
    await txRef.update(updates);

    return {
      success: true,
      transactionId,
      historyId: historyRef.id,
      changes: newValues,
    };
  },
  {
    name: "updateTransaction",
    description:
      "Update a transaction's description or completion status. REQUIRES USER CONFIRMATION.",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID"),
      description: z.string().optional().describe("New description"),
      isComplete: z.boolean().optional().describe("Mark as complete/incomplete"),
    }),
  }
);

// ============================================================================
// Create Source
// ============================================================================

export const createSourceTool = tool(
  async ({ name, iban, currency }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const sourceRef = await db.collection("sources").add({
      userId,
      name,
      iban,
      currency: currency || "EUR",
      isActive: true,
      transactionCount: 0,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    return {
      success: true,
      sourceId: sourceRef.id,
      name,
      iban,
    };
  },
  {
    name: "createSource",
    description: "Create a new bank account/source. REQUIRES USER CONFIRMATION.",
    schema: z.object({
      name: z.string().describe("Display name for the account"),
      iban: z.string().describe("IBAN of the account"),
      currency: z.string().optional().describe("Currency code (default EUR)"),
    }),
  }
);

// ============================================================================
// Rollback Transaction
// ============================================================================

export const rollbackTransactionTool = tool(
  async ({ transactionId, historyId }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) {
      return { error: "User ID not provided" };
    }

    const db = await getDb();
    const txRef = db.collection("transactions").doc(transactionId);
    const txDoc = await txRef.get();

    if (!txDoc.exists) {
      return { error: "Transaction not found" };
    }

    const txData = txDoc.data()!;
    if (txData.userId !== userId) {
      return { error: "Transaction not found" };
    }

    // Get the history entry
    const historyRef = txRef.collection("history").doc(historyId);
    const historyDoc = await historyRef.get();

    if (!historyDoc.exists) {
      return { error: "History entry not found" };
    }

    const historyData = historyDoc.data()!;
    const { previousValues } = historyData;

    if (!previousValues || Object.keys(previousValues).length === 0) {
      return { error: "No previous values to restore" };
    }

    // Create a new history entry for the rollback
    const rollbackHistoryRef = txRef.collection("history").doc();
    await rollbackHistoryRef.set({
      changedAt: Timestamp.now(),
      changedBy: userId,
      previousValues: Object.fromEntries(
        Object.keys(previousValues).map((key) => [key, txData[key]])
      ),
      newValues: previousValues,
      rollbackFrom: historyId,
    });

    // Apply the rollback
    await txRef.update({
      ...previousValues,
      updatedAt: Timestamp.now(),
    });

    return {
      success: true,
      transactionId,
      restoredValues: previousValues,
      historyId: rollbackHistoryRef.id,
    };
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
// Assign Partner to Transaction
// ============================================================================

export const assignPartnerToTransactionTool = tool(
  async ({ transactionId, partnerId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    const db = await getDb();

    try {
      // Call Cloud Function - handles validation, pattern learning, and receipt search
      const result = await callFirebaseFunction<
        { transactionId: string; partnerId: string; partnerType: "user"; matchedBy: "ai" },
        { success: boolean }
      >(
        "assignPartnerToTransaction",
        {
          transactionId,
          partnerId,
          partnerType: "user",
          matchedBy: "ai",
        },
        authHeader
      );

      if (!result.success) {
        return { error: "Failed to assign partner" };
      }

      // Get partner name for response
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      const partnerName = partnerDoc.exists ? partnerDoc.data()?.name : "Unknown";

      return {
        success: true,
        transactionId,
        partnerId,
        partnerName,
        message: `Assigned partner "${partnerName}" to transaction`,
      };
    } catch (err) {
      const error = err as Error;
      // Check for rejection error from Cloud Function
      if (error.message?.includes("rejected") || error.message?.includes("removed")) {
        return {
          error: error.message,
          wasRejected: true,
        };
      }
      return { error: error.message || "Failed to assign partner" };
    }
  },
  {
    name: "assignPartnerToTransaction",
    description:
      "Assign a partner (vendor/supplier) to a transaction. Use after finding/creating the partner.",
    schema: z.object({
      transactionId: z.string().describe("The transaction ID"),
      partnerId: z.string().describe("The partner ID to assign"),
    }),
  }
);

// ============================================================================
// Assign Partner to File
// ============================================================================

export const assignPartnerToFileTool = tool(
  async ({ fileId, partnerId }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    const db = await getDb();

    try {
      // Call updateFile Cloud Function to assign the partner
      const result = await callFirebaseFunction<
        { fileId: string; data: { partnerId: string; partnerType: "user"; partnerMatchedBy: "ai" } },
        { success: boolean }
      >(
        "updateFile",
        {
          fileId,
          data: {
            partnerId,
            partnerType: "user",
            partnerMatchedBy: "ai",
          },
        },
        authHeader
      );

      if (!result.success) {
        return { error: "Failed to assign partner to file" };
      }

      // Get partner name for response
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      const partnerName = partnerDoc.exists ? partnerDoc.data()?.name : "Unknown";

      return {
        success: true,
        fileId,
        partnerId,
        partnerName,
        message: `Assigned partner "${partnerName}" to file`,
      };
    } catch (err) {
      const error = err as Error;
      return { error: error.message || "Failed to assign partner to file" };
    }
  },
  {
    name: "assignPartnerToFile",
    description:
      "Assign a partner (vendor/supplier) to a file/invoice. Use after finding/creating the partner. This directly assigns the partner to the file without needing a transaction.",
    schema: z.object({
      fileId: z.string().describe("The file ID"),
      partnerId: z.string().describe("The partner ID to assign"),
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
// Update Partner
// ============================================================================

export const updatePartnerTool = tool(
  async ({ partnerId, name, aliases, vatId, website, country }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) {
      return { error: "Auth header not provided" };
    }

    const db = await getDb();

    // Get current partner for comparison (read-only)
    const partnerDoc = await db.collection("partners").doc(partnerId).get();
    if (!partnerDoc.exists) {
      return { error: "Partner not found" };
    }

    const partnerData = partnerDoc.data()!;
    if (partnerData.userId !== userId) {
      return { error: "Partner not found" };
    }

    // Build update object and track changes
    const updateData: Record<string, unknown> = {};
    const changes: string[] = [];

    if (name !== undefined && name !== partnerData.name) {
      updateData.name = name.trim();
      changes.push(`name: "${partnerData.name}" → "${name.trim()}"`);
    }

    if (aliases !== undefined) {
      updateData.aliases = aliases.map((a: string) => a.trim()).filter(Boolean);
      changes.push(`aliases updated`);
    }

    if (vatId !== undefined && vatId !== partnerData.vatId) {
      const normalizedVat = vatId ? vatId.toUpperCase().replace(/\s/g, "") : null;

      if (normalizedVat) {
        try {
          const validation = await lookupByVatId(normalizedVat, authHeader);
          if (validation.viesValid) {
            updateData.vatId = normalizedVat;
            changes.push(`vatId: "${partnerData.vatId || "none"}" → "${normalizedVat}" (✓ valid)`);
            if (validation.name && name === undefined && !partnerData.name) {
              updateData.name = validation.name;
              changes.push(`name set from VIES: "${validation.name}"`);
            }
          } else {
            changes.push(`vatId: "${normalizedVat}" (⚠ invalid: ${validation.viesError})`);
            updateData.vatId = normalizedVat;
          }
        } catch (error) {
          console.error("[updatePartner] VAT validation failed:", error);
          updateData.vatId = normalizedVat;
          changes.push(`vatId: "${normalizedVat}" (validation failed)`);
        }
      } else {
        updateData.vatId = null;
        changes.push(`vatId removed`);
      }
    }

    if (website !== undefined && website !== partnerData.website) {
      updateData.website = website || null;
      changes.push(`website: "${partnerData.website || "none"}" → "${website || "none"}"`);
    }

    if (country !== undefined && country !== partnerData.country) {
      updateData.country = country || null;
      changes.push(`country: "${partnerData.country || "none"}" → "${country || "none"}"`);
    }

    if (changes.length === 0) {
      return {
        success: true,
        partnerId,
        partnerName: partnerData.name,
        message: "No changes to apply",
      };
    }

    // Call Cloud Function to update
    try {
      await callFirebaseFunction<
        { partnerId: string; data: Record<string, unknown> },
        { success: boolean }
      >(
        "updateUserPartner",
        { partnerId, data: updateData },
        authHeader
      );

      return {
        success: true,
        partnerId,
        partnerName: (updateData.name as string) || partnerData.name,
        changes,
        message: `Updated partner "${(updateData.name as string) || partnerData.name}"`,
      };
    } catch (err) {
      const error = err as Error;
      return { error: error.message || "Failed to update partner" };
    }
  },
  {
    name: "updatePartner",
    description: `Update an existing partner's details. VAT IDs are automatically validated via EU VIES.
Use this to correct partner information like name, VAT ID, website, or country.`,
    schema: z.object({
      partnerId: z.string().describe("The partner ID to update"),
      name: z.string().optional().describe("New partner name"),
      aliases: z.array(z.string()).optional().describe("New list of aliases/patterns"),
      vatId: z.string().optional().describe("New VAT ID (will be validated via VIES)"),
      website: z.string().optional().describe("New website URL"),
      country: z.string().optional().describe("New country code (e.g., AT, DE)"),
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

    const db = await getDb();

    // Get partner name for response
    const partnerDoc = await db.collection("partners").doc(partnerId).get();
    if (!partnerDoc.exists) {
      return { error: "Partner not found" };
    }
    const partnerName = partnerDoc.data()?.name || "Unknown";

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
      data.partnerId = partnerId;
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

    return {
      success: true,
      updatedCount: result.success,
      failedCount: result.failed,
      failed: result.failed > 0 ? result.errors : undefined,
      message: `Updated ${result.success} transaction(s)${result.failed > 0 ? `, ${result.failed} failed` : ""}.`,
    };
  },
  {
    name: "bulkUpdateTransactions",
    description:
      "Bulk-update many transactions (description, completion, partner assignment, or no-receipt category). Use after listTransactions has shown the user the candidate rows and they have confirmed the change. Pass clearNoReceiptCategory=true to remove an existing category (e.g. flipping 'private' → needs receipt). Requires user confirmation.",
    schema: z.object({
      transactionIds: z.array(z.string()).min(1).describe("Transaction IDs to update (max 1000)"),
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
  bulkAssignPartnerToTransactionsTool,
  bulkUpdateTransactionsTool,
  matchTransactionPartnersTool,
  createPartnerTool,
  updatePartnerTool,
  findOrCreatePartnerTool,
];
