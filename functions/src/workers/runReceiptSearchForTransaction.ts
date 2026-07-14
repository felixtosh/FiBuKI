/**
 * Run Receipt Search for Transaction
 *
 * Callable function that runs a receipt search worker for a transaction.
 * Calls the worker API directly (server-to-server) for immediate execution.
 *
 * This is triggered after a partner is assigned to find matching receipts.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { AutomationMeta } from "../automation/types";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "runReceiptSearchForTransaction",
  name: "Precision Receipt Search",
  description:
    "Agentic search that finds receipts in Gmail for a transaction using AI-generated queries, file analysis, and smart matching",
  trigger: {
    type: "callable",
    regions: ["europe-west1"],
  },
  effects: [
    {
      entity: "file",
      fields: ["transactionIds", "transactionMatchComplete"],
      action: "update",
    },
    {
      entity: "transaction",
      fields: ["fileIds"],
      action: "update",
    },
    {
      entity: "fileConnection",
      fields: ["fileId", "transactionId", "connectionType", "matchConfidence"],
      action: "create",
    },
    {
      entity: "workerRequest",
      fields: ["status", "result", "completedAt"],
      action: "update",
    },
  ],
  icon: "Bot",
  category: "search",
  aiPowered: true,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const db = getFirestore();

/**
 * Check if user has any active email integration (connected and not needing reauth).
 * If no email integration exists, receipt search should be skipped entirely.
 */
async function hasActiveEmailIntegration(userId: string): Promise<boolean> {
  const activeIntegrationSnapshot = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .where("needsReauth", "==", false)
    .limit(1)
    .get();

  return !activeIntegrationSnapshot.empty;
}

// Get the app URL for server-to-server calls
function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  // In the emulator, call the local Next.js dev server
  if (process.env.FUNCTIONS_EMULATOR === "true") return "http://localhost:3000";
  return "https://fibuki.com";
}

// ============================================================================
// Shared Logic (can be called from other Cloud Functions)
// ============================================================================

interface QueueReceiptSearchOptions {
  transactionId: string;
  userId: string;
  partnerId?: string;
  force?: boolean;
}

/**
 * Helper to create a workerRequest document (fallback/queuing mode)
 */
async function queueAsDocument(
  transactionId: string,
  userId: string,
  partnerId: string | undefined,
  initialPrompt?: string
): Promise<QueueReceiptSearchResult> {
  // Build prompt if not provided
  let prompt = initialPrompt;
  if (!prompt) {
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    const txData = txDoc.data();
    const promptParts = [`Find receipt for transaction ${transactionId}`];
    if (txData?.partner || txData?.name) {
      promptParts.push(`Partner: ${txData.partner || txData.name}`);
    }
    if (txData?.amount) {
      promptParts.push(`Amount: ${(txData.amount / 100).toFixed(2)} ${txData.currency || "EUR"}`);
    }
    if (txData?.date?.toDate) {
      promptParts.push(`Date: ${txData.date.toDate().toISOString().split("T")[0]}`);
    }
    prompt = promptParts.join(". ");
  }

  const triggerContext: Record<string, string> = { transactionId };
  if (partnerId) {
    triggerContext.partnerId = partnerId;
  }

  const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
  await requestRef.set({
    id: requestRef.id,
    workerType: "receipt_search",
    initialPrompt: prompt,
    triggerContext,
    triggeredBy: "auto",
    status: "pending",
    createdAt: Timestamp.now(),
  });

  await db.collection("transactions").doc(transactionId).update({
    automationHistory: FieldValue.arrayUnion({
      type: "receipt_search",
      ranAt: Timestamp.now(),
      status: "pending",
      actor: "auto",
      level: "info" as const,
      forPartnerId: partnerId || null,
      workerRunId: requestRef.id,
      summary: "Receipt search queued",
    }),
  });

  console.log(`[QueueReceiptSearch] Queued worker request ${requestRef.id} for transaction ${transactionId}`);

  return {
    success: true,
    message: `Receipt search queued for transaction ${transactionId}`,
    workerRequestId: requestRef.id,
  };
}

interface QueueReceiptSearchResult {
  success: boolean;
  message: string;
  workerRequestId?: string;
  workerRunId?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Call the worker API directly (server-to-server)
 *
 * Authenticated with the shared internal secret (INTERNAL_API_SECRET), not a
 * forged token. The Next.js auth helper verifies Firebase ID tokens now, so a
 * self-minted JWT would (correctly) be rejected. When INTERNAL_API_SECRET is
 * unset the call fails auth and the caller falls back to document-based queuing.
 */
async function callWorkerApiDirectly(
  userId: string,
  workerType: string,
  initialPrompt: string,
  triggerContext: Record<string, string>
): Promise<{ runId: string; status: string; summary?: string } | null> {
  const appUrl = getAppUrl();

  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) {
    console.warn(
      "[QueueReceiptSearch] INTERNAL_API_SECRET not set; skipping direct worker call, falling back to queue"
    );
    return null;
  }

  try {
    // Call the worker API (server-to-server, authenticated via internal secret)
    console.log(`[QueueReceiptSearch] Calling worker API at ${appUrl}/api/worker`);
    const response = await fetch(`${appUrl}/api/worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
        "X-Internal-User-Id": userId,
      },
      body: JSON.stringify({
        workerType,
        initialPrompt,
        triggerContext,
        triggeredBy: "auto",
        modelProvider: "gemini",
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("[QueueReceiptSearch] Worker API returned error:", result);
      return null;
    }

    return result;
  } catch (error) {
    console.error("[QueueReceiptSearch] Failed to call worker API:", error);
    return null;
  }
}

/**
 * Run a receipt search worker for a transaction.
 * Tries to call worker API directly, falls back to document-based queuing.
 * Can be called from other Cloud Functions.
 */
export async function queueReceiptSearchForTransaction(
  options: QueueReceiptSearchOptions
): Promise<QueueReceiptSearchResult> {
  const { transactionId, userId, partnerId, force = false } = options;

  // Check if there's already a running worker for this user (rate limiting)
  const runningWorkers = await db
    .collection(`users/${userId}/workerRuns`)
    .where("status", "==", "running")
    .limit(1)
    .get();

  if (!runningWorkers.empty) {
    // Another worker is running - queue this one instead of running directly
    console.log(`[QueueReceiptSearch] Another worker is running for user ${userId}, queuing instead`);
    return queueAsDocument(transactionId, userId, partnerId);
  }

  // Get transaction data
  const txDoc = await db.collection("transactions").doc(transactionId).get();
  if (!txDoc.exists) {
    return {
      success: false,
      message: `Transaction ${transactionId} not found`,
    };
  }

  const txData = txDoc.data()!;

  // Check ownership
  if (txData.userId !== userId) {
    return {
      success: false,
      message: "Not authorized",
    };
  }

  // Check if transaction already has files
  const hasFiles = txData.fileIds && txData.fileIds.length > 0;
  if (hasFiles && !force) {
    return {
      success: true,
      message: "Transaction already has files attached",
      skipped: true,
      skipReason: "has_files",
    };
  }

  // Check if transaction has a no-receipt category (considered complete)
  const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
  if (hasNoReceiptCategory && !force) {
    return {
      success: true,
      message: "Transaction has a no-receipt category assigned",
      skipped: true,
      skipReason: "has_no_receipt_category",
    };
  }

  // Note: we intentionally do NOT skip based on "already ran for this partner".
  // The has_files and has_no_receipt_category checks above already handle resolved
  // transactions. If a previous search ran but found nothing, a retry may succeed
  // (new emails arrived, different queries generated, etc.).

  // Check if user has an active email integration
  // Skip receipt search if no Gmail is connected - avoids wasting resources
  const hasEmailIntegration = await hasActiveEmailIntegration(userId);
  if (!hasEmailIntegration) {
    console.log(`[QueueReceiptSearch] No active email integration for user ${userId}, skipping receipt search`);
    return {
      success: true,
      message: "No email service connected - receipt search skipped",
      skipped: true,
      skipReason: "no_email_integration",
    };
  }

  // Build prompt from transaction data
  const promptParts = [`Find receipt for transaction ${transactionId}`];
  if (txData.partner || txData.name) {
    promptParts.push(`Partner: ${txData.partner || txData.name}`);
  }
  if (txData.amount) {
    promptParts.push(`Amount: ${(txData.amount / 100).toFixed(2)} ${txData.currency || "EUR"}`);
  }
  if (txData.date?.toDate) {
    promptParts.push(`Date: ${txData.date.toDate().toISOString().split("T")[0]}`);
  }

  const initialPrompt = promptParts.join(". ");

  // Build trigger context (excluding undefined values)
  const triggerContext: Record<string, string> = { transactionId };
  if (partnerId) {
    triggerContext.partnerId = partnerId;
  }

  // Try to call worker API directly
  const directResult = await callWorkerApiDirectly(userId, "receipt_search", initialPrompt, triggerContext);

  if (directResult) {
    // Direct execution succeeded
    await db.collection("transactions").doc(transactionId).update({
      automationHistory: FieldValue.arrayUnion({
        type: "receipt_search",
        ranAt: Timestamp.now(),
        status: directResult.status,
        actor: "auto",
        level: "info" as const,
        forPartnerId: partnerId || null,
        workerRunId: directResult.runId,
        summary: directResult.summary || "Receipt search completed",
      }),
    });

    console.log(`[QueueReceiptSearch] Direct execution completed: ${directResult.runId}`);

    return {
      success: true,
      message: `Receipt search completed for transaction ${transactionId}`,
      workerRunId: directResult.runId,
    };
  }

  // Fallback: Queue as document for later processing
  return queueAsDocument(transactionId, userId, partnerId, initialPrompt);
}

// ============================================================================
// Types (for callable)
// ============================================================================

interface RunReceiptSearchRequest {
  transactionId: string;
  partnerId?: string;
  /** Force run even if already ran for this partner */
  force?: boolean;
}

// ============================================================================
// Callable (uses shared logic)
// ============================================================================

/**
 * Queue a receipt search worker for a transaction.
 *
 * Checks conditions before queuing:
 * - Transaction must not have files attached
 * - Must not have already run for this partner (unless forced)
 */
export const runReceiptSearchForTransactionCallable = createCallable<
  RunReceiptSearchRequest,
  QueueReceiptSearchResult
>(
  {
    name: "runReceiptSearchForTransaction",
  },
  async (ctx, request) => {
    const { transactionId, partnerId, force = false } = request;

    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    return queueReceiptSearchForTransaction({
      transactionId,
      userId: ctx.userId,
      partnerId,
      force,
    });
  }
);
