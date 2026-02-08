/**
 * Sync Bank Transactions Callable
 *
 * Cloud Function for syncing transactions from finAPI with full
 * deduplication, orphan handling, and import record creation.
 *
 * Replaces the logic from /app/api/banking/sync/route.ts
 */

import { defineSecret } from "firebase-functions/params";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import type {
  SyncBankTransactionsRequest,
  SyncBankTransactionsResponse,
} from "../types/banking-sync";

// Define secrets for finAPI credentials
const finapiClientId = defineSecret("FINAPI_CLIENT_ID");
const finapiClientSecret = defineSecret("FINAPI_CLIENT_SECRET");

// finAPI base URLs
const FINAPI_SANDBOX_URL = "https://sandbox.finapi.io";
const FINAPI_LIVE_URL = "https://live.finapi.io";

// Use sandbox by default, can be configured via env
const getBaseUrl = () =>
  process.env.FINAPI_ENVIRONMENT === "live"
    ? FINAPI_LIVE_URL
    : FINAPI_SANDBOX_URL;

// ============================================================================
// Types
// ============================================================================

interface FinapiTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in: number;
}

interface FinapiTransaction {
  id: number;
  accountId: number;
  valueDate: string;
  bankBookingDate: string;
  amount: number;
  currency?: string;
  purpose?: string;
  counterpartName?: string;
  counterpartIban?: string;
  counterpartBic?: string;
  counterpartBankName?: string;
  endToEndReference?: string;
  mandateReference?: string;
  creditorId?: string;
  primanota?: string;
  type?: string;
}

interface FinapiTransactionList {
  transactions: FinapiTransaction[];
  paging: {
    page: number;
    perPage: number;
    totalPages: number;
    totalCount: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

async function refreshUserToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<FinapiTokenResponse> {
  const formData = new URLSearchParams();
  formData.append("grant_type", "refresh_token");
  formData.append("client_id", clientId);
  formData.append("client_secret", clientSecret);
  formData.append("refresh_token", refreshToken);

  const response = await fetch(`${getBaseUrl()}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const oauthError = error as { error?: string; error_description?: string };
    const message =
      error.errors?.[0]?.message ||
      oauthError.error_description ||
      oauthError.error ||
      `Token refresh failed: ${response.status}`;

    // If refresh token is invalid/expired, throw specific error
    if (
      message.includes("expired") ||
      message.includes("invalid") ||
      response.status === 400
    ) {
      throw new HttpsError(
        "failed-precondition",
        "REAUTH_REQUIRED",
        { code: "REAUTH_REQUIRED", message }
      );
    }
    throw new Error(message);
  }

  return response.json();
}

async function fetchAllTransactions(
  userToken: string,
  accountIds: number[],
  minDate?: string,
  maxDate?: string
): Promise<FinapiTransaction[]> {
  const allTransactions: FinapiTransaction[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      accountIds: accountIds.join(","),
      page: String(page),
      perPage: "500",
      view: "bankView",
      direction: "all",
    });

    if (minDate) params.append("minBankBookingDate", minDate);
    if (maxDate) params.append("maxBankBookingDate", maxDate);

    const response = await fetch(
      `${getBaseUrl()}/api/v2/transactions?${params}`,
      {
        headers: { Authorization: `Bearer ${userToken}` },
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.errors?.[0]?.message || `Fetch failed: ${response.status}`
      );
    }

    const data: FinapiTransactionList = await response.json();
    allTransactions.push(...data.transactions);
    hasMore = page < data.paging.totalPages;
    page++;
  }

  return allTransactions;
}

// ============================================================================
// Callable Function
// ============================================================================

export const syncBankTransactionsCallable = createCallable<
  SyncBankTransactionsRequest,
  SyncBankTransactionsResponse
>(
  {
    name: "syncBankTransactions",
    timeoutSeconds: 300, // 5 minutes for large syncs
    memory: "1GiB",
    secrets: [finapiClientId, finapiClientSecret],
  },
  async (ctx, request) => {
    const { sourceId, fromYear } = request;

    if (!sourceId) {
      throw new HttpsError("invalid-argument", "sourceId is required");
    }

    // Determine sync start year (default to current year)
    const syncFromYear = fromYear || new Date().getFullYear();

    const db = ctx.db;
    const userId = ctx.userId;

    // ========================================================================
    // 1. Validate source ownership
    // ========================================================================
    const sourceRef = db.collection("sources").doc(sourceId);
    const sourceDoc = await sourceRef.get();

    if (!sourceDoc.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    const source = sourceDoc.data();
    if (source?.userId !== userId) {
      throw new HttpsError("permission-denied", "Not authorized for this source");
    }

    if (source?.type !== "api" || !source?.apiConfig) {
      throw new HttpsError("invalid-argument", "Source is not an API-connected account");
    }

    const config = source.apiConfig;
    if (config.provider !== "finapi") {
      throw new HttpsError("invalid-argument", "Only finAPI sources are supported");
    }

    // ========================================================================
    // 2. Check token expiry and re-auth status
    // ========================================================================
    const expiresAt = config.expiresAt?.toDate?.() ||
      (config.expiresAt ? new Date(config.expiresAt) : null);

    if (expiresAt && expiresAt < new Date()) {
      throw new HttpsError(
        "failed-precondition",
        "Re-authentication required",
        { code: "REAUTH_REQUIRED", expiresAt: expiresAt.toISOString() }
      );
    }

    const clientId = finapiClientId.value();
    const clientSecret = finapiClientSecret.value();

    // ========================================================================
    // 3. Refresh token if needed
    // ========================================================================
    let userToken = config.userAccessToken;
    const tokenExpiry = config.tokenExpiresAt?.toDate?.() ||
      (config.tokenExpiresAt ? new Date(config.tokenExpiresAt) : null);

    if (tokenExpiry && Date.now() > tokenExpiry.getTime() - 5 * 60 * 1000) {
      console.log("[syncBankTransactions] Refreshing token...");
      const tokenResponse = await refreshUserToken(
        config.userRefreshToken,
        clientId,
        clientSecret
      );
      userToken = tokenResponse.access_token;

      // Update tokens in source
      await sourceRef.update({
        "apiConfig.userAccessToken": userToken,
        "apiConfig.userRefreshToken":
          tokenResponse.refresh_token || config.userRefreshToken,
        "apiConfig.tokenExpiresAt": Timestamp.fromDate(
          new Date(Date.now() + tokenResponse.expires_in * 1000)
        ),
      });
    }

    // ========================================================================
    // 4. Year change handling - delete existing transactions if year changed
    // ========================================================================
    const isYearChange = fromYear && fromYear !== config.syncFromYear;

    if (isYearChange) {
      console.log(
        `[syncBankTransactions] Year changed to ${fromYear}, deleting existing transactions...`
      );

      // Delete all existing transactions for this source
      const existingTxQuery = await db
        .collection("transactions")
        .where("sourceId", "==", sourceId)
        .get();

      const BATCH_SIZE = 500;
      for (let i = 0; i < existingTxQuery.docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const slice = existingTxQuery.docs.slice(i, i + BATCH_SIZE);
        for (const txDoc of slice) {
          batch.delete(txDoc.ref);
        }
        await batch.commit();
      }
      console.log(
        `[syncBankTransactions] Deleted ${existingTxQuery.docs.length} existing transactions`
      );

      // Also delete existing import records for this source
      const existingImportsQuery = await db
        .collection("imports")
        .where("sourceId", "==", sourceId)
        .get();

      for (let i = 0; i < existingImportsQuery.docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const slice = existingImportsQuery.docs.slice(i, i + BATCH_SIZE);
        for (const importDoc of slice) {
          batch.delete(importDoc.ref);
        }
        await batch.commit();
      }
    }

    // ========================================================================
    // 5. Calculate date range and fetch transactions
    // ========================================================================
    const dateFrom = `${syncFromYear}-01-01`;
    const dateTo = new Date().toISOString().split("T")[0];

    console.log(
      `[syncBankTransactions] Fetching transactions from ${dateFrom} to ${dateTo}`
    );

    const accountId = parseInt(config.accountId, 10);
    const transactions = await fetchAllTransactions(
      userToken,
      [accountId],
      dateFrom,
      dateTo
    );

    console.log(
      `[syncBankTransactions] Fetched ${transactions.length} transactions`
    );

    // ========================================================================
    // 6. IBAN-based orphan detection and reassignment
    // ========================================================================
    const iban = source.iban;
    let reassignedCount = 0;

    if (iban) {
      // Find all sources for this user to identify which sourceIds are valid
      const userSourcesQuery = await db
        .collection("sources")
        .where("userId", "==", userId)
        .get();
      const validSourceIds = new Set(userSourcesQuery.docs.map((d) => d.id));

      // Find transactions with dedupeHash starting with this IBAN but with orphaned sourceId
      const orphanedQuery = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("dedupeHash", ">=", `${iban}|`)
        .where("dedupeHash", "<", `${iban}|~`) // ~ is after | in ASCII
        .get();

      const orphanedToReassign = orphanedQuery.docs.filter((d) => {
        const txSourceId = d.data().sourceId;
        return txSourceId !== sourceId && !validSourceIds.has(txSourceId);
      });

      if (orphanedToReassign.length > 0) {
        console.log(
          `[syncBankTransactions] Found ${orphanedToReassign.length} orphaned transactions with IBAN ${iban}, reassigning to ${sourceId}`
        );

        const BATCH_SIZE = 500;
        for (let i = 0; i < orphanedToReassign.length; i += BATCH_SIZE) {
          const batch = db.batch();
          const slice = orphanedToReassign.slice(i, i + BATCH_SIZE);
          for (const doc of slice) {
            batch.update(doc.ref, {
              sourceId,
              updatedAt: Timestamp.now(),
            });
          }
          await batch.commit();
        }
        reassignedCount += orphanedToReassign.length;
        console.log(
          `[syncBankTransactions] Reassigned ${orphanedToReassign.length} orphaned transactions`
        );
      }
    }

    // ========================================================================
    // 7. Handle empty result
    // ========================================================================
    if (transactions.length === 0) {
      // Still fetch balance even if no new transactions
      const emptyBalanceUpdates: Record<string, unknown> = {};
      try {
        const acctResp = await fetch(
          `${getBaseUrl()}/api/v2/accounts/${accountId}`,
          { headers: { Authorization: `Bearer ${userToken}` } }
        );
        if (acctResp.ok) {
          const acctData = await acctResp.json();
          if (acctData.balance != null) {
            emptyBalanceUpdates.latestBalance = Math.round(acctData.balance * 100);
            emptyBalanceUpdates.latestBalanceDate = Timestamp.now();
          }
        }
      } catch {
        // Non-fatal
      }

      await sourceRef.update({
        "apiConfig.lastSyncAt": Timestamp.now(),
        "apiConfig.syncFromYear": syncFromYear,
        "apiConfig.lastSyncError": FieldValue.delete(),
        ...emptyBalanceUpdates,
      });

      return {
        success: true,
        imported: 0,
        skipped: 0,
        reassigned: reassignedCount,
        total: 0,
      };
    }

    // ========================================================================
    // 8. Transform transactions to internal format
    // ========================================================================
    const syncJobId = `sync_${sourceId}_${Date.now()}`;
    const ibanForHash = source.iban || sourceId;

    const txDocs = transactions.map((tx: FinapiTransaction) => ({
      // Core fields
      name: tx.purpose || tx.counterpartName || "Unknown",
      description: tx.purpose || null,
      amount: Math.round(tx.amount * 100), // Convert to cents
      currency: tx.currency || "EUR",
      date: Timestamp.fromDate(new Date(tx.bankBookingDate)),

      // Counterparty info
      partner: tx.counterpartName || null,
      partnerIban: tx.counterpartIban || null,

      // Reference
      reference:
        tx.endToEndReference ||
        tx.mandateReference ||
        tx.primanota ||
        String(tx.id),

      // Store original data for debugging
      _original: {
        date: tx.bankBookingDate,
        amount: String(tx.amount),
        rawRow: {
          id: String(tx.id),
          valueDate: tx.valueDate,
          bankBookingDate: tx.bankBookingDate,
          purpose: tx.purpose || "",
          counterpartName: tx.counterpartName || "",
          counterpartIban: tx.counterpartIban || "",
          counterpartBic: tx.counterpartBic || "",
          counterpartBankName: tx.counterpartBankName || "",
          type: tx.type || "",
          endToEndReference: tx.endToEndReference || "",
          mandateReference: tx.mandateReference || "",
          creditorId: tx.creditorId || "",
        },
      },

      // Classification defaults
      isComplete: false,
      fileIds: [],
      partnerId: null,
      partnerType: null,
      partnerMatchConfidence: null,
      partnerMatchedBy: null,
      noReceiptCategoryId: null,

      // Metadata
      sourceId,
      userId,
      importJobId: syncJobId,
      dedupeHash: `${ibanForHash}|${tx.bankBookingDate}|${tx.amount}|${tx.currency}|${tx.id}`,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }));

    // ========================================================================
    // 9. Deduplication - check by userId + dedupeHash (not sourceId)
    // ========================================================================
    const hashes = txDocs.map((t) => t.dedupeHash);
    const existingHashes = new Set<string>();
    const orphanedTxIds: string[] = [];

    // Query in chunks (Firestore's 30-item limit for 'in')
    for (let i = 0; i < hashes.length; i += 30) {
      const chunk = hashes.slice(i, i + 30);
      const chunkQuery = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("dedupeHash", "in", chunk)
        .get();

      chunkQuery.docs.forEach((d) => {
        existingHashes.add(d.data().dedupeHash);
        // Track orphaned transactions found during dedup (different sourceId = possibly orphaned)
        if (d.data().sourceId !== sourceId) {
          orphanedTxIds.push(d.id);
        }
      });
    }

    // Reassign any orphaned transactions found during dedup
    if (orphanedTxIds.length > 0) {
      console.log(
        `[syncBankTransactions] Reassigning ${orphanedTxIds.length} orphaned transactions found during dedup`
      );
      const BATCH_SIZE = 500;
      for (let i = 0; i < orphanedTxIds.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const slice = orphanedTxIds.slice(i, i + BATCH_SIZE);
        for (const txId of slice) {
          batch.update(db.collection("transactions").doc(txId), {
            sourceId,
            updatedAt: Timestamp.now(),
          });
        }
        await batch.commit();
      }
      reassignedCount += orphanedTxIds.length;
    }

    // Filter out duplicates
    const newTransactions = txDocs.filter(
      (t) => !existingHashes.has(t.dedupeHash)
    );

    console.log(
      `[syncBankTransactions] ${newTransactions.length} new, ${existingHashes.size} duplicates`
    );

    // ========================================================================
    // 10. Batch write new transactions
    // ========================================================================
    const BATCH_SIZE = 500;
    let imported = 0;

    for (let i = 0; i < newTransactions.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const slice = newTransactions.slice(i, i + BATCH_SIZE);

      for (const tx of slice) {
        const docRef = db.collection("transactions").doc();
        batch.set(docRef, tx);
        imported++;
      }

      await batch.commit();
    }

    // ========================================================================
    // 11. Create import record for audit
    // ========================================================================
    const importRecord = {
      sourceId,
      userId,
      fileName: "Bank Sync",
      importType: "api",
      syncDateFrom: dateFrom,
      syncDateTo: dateTo,
      syncProvider: "finapi",
      status: "completed",
      totalRows: transactions.length,
      importedCount: imported,
      skippedCount: existingHashes.size,
      reassignedCount,
      errorCount: 0,
      createdAt: Timestamp.now(),
    };

    await db.collection("imports").doc(syncJobId).set(importRecord);
    console.log(`[syncBankTransactions] Created import record ${syncJobId}`);

    // ========================================================================
    // 12. Fetch account balance from finAPI (best effort)
    // ========================================================================
    const balanceUpdates: Record<string, unknown> = {};
    try {
      const accountResponse = await fetch(
        `${getBaseUrl()}/api/v2/accounts/${accountId}`,
        { headers: { Authorization: `Bearer ${userToken}` } }
      );

      if (accountResponse.ok) {
        const accountData = await accountResponse.json();
        if (accountData.balance != null) {
          const balanceCents = Math.round(accountData.balance * 100);
          balanceUpdates.latestBalance = balanceCents;
          balanceUpdates.latestBalanceDate = Timestamp.now();
          console.log(`[syncBankTransactions] Updated balance: ${balanceCents} cents`);
        }
      }
    } catch (balanceError) {
      // Non-fatal: balance fetch is optional
      console.warn("[syncBankTransactions] Could not fetch balance:", balanceError);
    }

    // ========================================================================
    // 13. Update source lastSyncAt
    // ========================================================================
    await sourceRef.update({
      "apiConfig.lastSyncAt": Timestamp.now(),
      "apiConfig.syncFromYear": syncFromYear,
      "apiConfig.lastSyncError": FieldValue.delete(),
      ...balanceUpdates,
    });

    return {
      success: true,
      imported,
      skipped: existingHashes.size,
      reassigned: reassignedCount,
      total: transactions.length,
      importRecordId: syncJobId,
    };
  }
);
