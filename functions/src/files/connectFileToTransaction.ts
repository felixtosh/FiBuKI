/**
 * Connect a file to a transaction (many-to-many relationship)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError, type HandlerContext } from "../utils/createCallable";
import {
  cancelFileWorkersForTransaction,
  cancelTransactionWorkersForFile,
  cancelPrecisionSearchForTransaction,
} from "../utils/cancelWorkers";
import { deriveActivityLevel } from "../utils/activityLevel";
import { learnBillingCycleForPartner } from "../matching/learnBillingCycle";
import { copyConnectCheck, CLEARED_COPY_MARK } from "./copyOps";
import { payeeFillForTransaction } from "../partners/payeeSync";

interface FileConnectionSourceInfo {
  sourceType?: string;
  searchPattern?: string;
  gmailIntegrationId?: string;
  gmailIntegrationEmail?: string;
  mailMessageId?: string;
  gmailMessageFrom?: string;
  gmailMessageFromName?: string;
  resultType?: string;
}

export interface ConnectFileRequest {
  fileId: string;
  transactionId: string;
  connectionType?: "manual" | "auto_matched";
  matchConfidence?: number;
  sourceInfo?: FileConnectionSourceInfo;
  /**
   * If true, this call may reassign existing auto/AI connections for the same
   * file or transaction. Manual/user-confirmed connections are never overridden.
   */
  allowAutoReassign?: boolean;
}

interface ConnectFileResponse {
  success: boolean;
  connectionId: string;
  alreadyConnected: boolean;
  reassignedConnections?: number;
}

interface PartnerFileSourcePattern {
  sourceType: string;
  pattern: string;
  integrationId?: string | null;
  resultType?: string;
  confidence: number;
  usageCount: number;
  sourceTransactionIds: string[];
  filenameExamples?: string[];
  createdAt: Timestamp;
  lastUsedAt: Timestamp;
  fromDomain?: string;
}

export const connectFileToTransactionCallable = createCallable<
  ConnectFileRequest,
  ConnectFileResponse
>({ name: "connectFileToTransaction" }, (ctx, request) =>
  performConnectFileToTransaction(ctx, request)
);

/**
 * The connect itself, for a caller that already holds the user: the
 * find-receipt workflow's auto-connect goes through here (#588), so it gets
 * the Copy refusal, the over-quota block, the Partner sync and the learning
 * a connect from the UI gets.
 */
export async function performConnectFileToTransaction(
  ctx: Pick<HandlerContext, "db" | "userId">,
  request: ConnectFileRequest
): Promise<ConnectFileResponse> {
  const {
    fileId,
    transactionId,
    connectionType = "manual",
    matchConfidence,
    sourceInfo,
    allowAutoReassign = false,
  } = request;

  if (!fileId || !transactionId) {
    throw new HttpsError("invalid-argument", "fileId and transactionId are required");
  }

  // Verify file ownership
  const fileRef = ctx.db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists) {
    throw new HttpsError("not-found", "File not found");
  }

  const fileData = fileSnap.data()!;
  if (fileData.userId !== ctx.userId) {
    throw new HttpsError("permission-denied", "File access denied");
  }

  // Verify transaction ownership
  const transactionRef = ctx.db.collection("transactions").doc(transactionId);
  const transactionSnap = await transactionRef.get();

  if (!transactionSnap.exists) {
    throw new HttpsError("not-found", "Transaction not found");
  }

  const transactionData = transactionSnap.data()!;
  if (transactionData.userId !== ctx.userId) {
    throw new HttpsError("permission-denied", "Transaction access denied");
  }

  // #162, ADR-0010: a Copy holds no File Connection.
  const copyCheck = await copyConnectCheck(ctx.db, fileData);
  if (copyCheck.refusal) {
    throw new HttpsError("failed-precondition", copyCheck.refusal);
  }

  // Block automated connections to over-quota transactions (manual still allowed)
  if (transactionData.quotaExceeded && connectionType !== "manual") {
    throw new HttpsError(
      "failed-precondition",
      "Automated file matching is disabled for over-quota transactions."
    );
  }

  // Check if connection already exists
  const existingQuery = await ctx.db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("transactionId", "==", transactionId)
    .where("userId", "==", ctx.userId)
    .limit(1)
    .get();

  if (!existingQuery.empty) {
    return {
      success: true,
      connectionId: existingQuery.docs[0].id,
      alreadyConnected: true,
    };
  }

  // Cancel running automation when user manually connects
  if (connectionType === "manual") {
    // Cancel file search workers for this transaction
    cancelFileWorkersForTransaction(ctx.userId, transactionId).catch((err) => {
      console.error("[connectFileToTransaction] Failed to cancel transaction workers:", err);
    });
    // Cancel transaction matching workers for this file
    cancelTransactionWorkersForFile(ctx.userId, fileId).catch((err) => {
      console.error("[connectFileToTransaction] Failed to cancel file workers:", err);
    });
    // Cancel precision search queue for this transaction
    cancelPrecisionSearchForTransaction(ctx.userId, transactionId).catch((err) => {
      console.error("[connectFileToTransaction] Failed to cancel precision search:", err);
    });
  }

  const now = Timestamp.now();
  const batch = ctx.db.batch();
  let reassignedConnections = 0;
  /** Files this call takes off the Transaction, so the payee rule ignores them. */
  const reassignedAwayFileIds = new Set<string>();

  const isAutoConnectionType = (value: unknown): boolean =>
    value === "auto_matched" || value === "ai_matched";

  // Optional safety mode for agentic flows: reassign existing auto connections.
  // This allows better matches to replace older auto links while preserving
  // manual/user-confirmed decisions.
  if (allowAutoReassign) {
    const [txConnectionsSnap, fileConnectionsSnap] = await Promise.all([
      ctx.db
        .collection("fileConnections")
        .where("transactionId", "==", transactionId)
        .where("userId", "==", ctx.userId)
        .get(),
      ctx.db
        .collection("fileConnections")
        .where("fileId", "==", fileId)
        .where("userId", "==", ctx.userId)
        .get(),
    ]);

    const lockedTxConnections = txConnectionsSnap.docs.filter((doc) => {
      const data = doc.data();
      if (data.fileId === fileId) return false;
      return !isAutoConnectionType(data.connectionType);
    });
    if (lockedTxConnections.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Transaction has manual/user-confirmed file matches; refusing auto reassignment."
      );
    }

    const lockedFileConnections = fileConnectionsSnap.docs.filter((doc) => {
      const data = doc.data();
      if (data.transactionId === transactionId) return false;
      return !isAutoConnectionType(data.connectionType);
    });
    if (lockedFileConnections.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "File has manual/user-confirmed transaction matches; refusing auto reassignment."
      );
    }

    const staleAutoById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    for (const doc of txConnectionsSnap.docs) {
      const data = doc.data();
      if (data.fileId === fileId) continue;
      if (isAutoConnectionType(data.connectionType)) {
        staleAutoById.set(doc.id, doc);
      }
    }
    for (const doc of fileConnectionsSnap.docs) {
      const data = doc.data();
      if (data.transactionId === transactionId) continue;
      if (isAutoConnectionType(data.connectionType)) {
        staleAutoById.set(doc.id, doc);
      }
    }

    if (staleAutoById.size > 0) {
      const removeTxIdsByFile = new Map<string, Set<string>>();
      const removeFileIdsByTx = new Map<string, Set<string>>();

      for (const staleDoc of staleAutoById.values()) {
        const staleData = staleDoc.data();
        const staleFileId = staleData.fileId as string | undefined;
        const staleTransactionId = staleData.transactionId as string | undefined;
        if (!staleFileId || !staleTransactionId) continue;

        if (!removeTxIdsByFile.has(staleFileId)) {
          removeTxIdsByFile.set(staleFileId, new Set());
        }
        removeTxIdsByFile.get(staleFileId)!.add(staleTransactionId);

        if (!removeFileIdsByTx.has(staleTransactionId)) {
          removeFileIdsByTx.set(staleTransactionId, new Set());
        }
        removeFileIdsByTx.get(staleTransactionId)!.add(staleFileId);
        if (staleTransactionId === transactionId) reassignedAwayFileIds.add(staleFileId);

        batch.delete(staleDoc.ref);
      }

      for (const [staleFileId, staleTxIds] of removeTxIdsByFile.entries()) {
        batch.update(ctx.db.collection("files").doc(staleFileId), {
          transactionIds: FieldValue.arrayRemove(...Array.from(staleTxIds)),
          updatedAt: now,
        });
      }

      for (const [staleTransactionId, staleFileIds] of removeFileIdsByTx.entries()) {
        const staleTxRef = ctx.db.collection("transactions").doc(staleTransactionId);
        const staleTxSnap = await staleTxRef.get();
        const staleTxData = staleTxSnap.exists ? staleTxSnap.data() || {} : {};
        const existingFileIds = Array.isArray(staleTxData.fileIds) ? staleTxData.fileIds : [];
        const remainingFileIds = existingFileIds.filter(
          (id: string) => !staleFileIds.has(id)
        );
        const hasNoReceiptCategory = !!staleTxData.noReceiptCategoryId;
        const staleUpdates: Record<string, unknown> = {
          fileIds: FieldValue.arrayRemove(...Array.from(staleFileIds)),
          updatedAt: now,
        };
        if (staleTransactionId !== transactionId && remainingFileIds.length === 0 && !hasNoReceiptCategory) {
          staleUpdates.isComplete = false;
        }
        batch.update(staleTxRef, staleUpdates);
      }

      reassignedConnections = staleAutoById.size;
    }
  }

  // Check if this transaction was in file's suggestions (for tracking accuracy)
  const suggestions: Array<{ transactionId: string; confidence: number }> =
    fileData.transactionSuggestions || [];
  const suggestedIndex = suggestions.findIndex(
    (s) => s.transactionId === transactionId
  );
  const wasSuggested = suggestedIndex >= 0;
  const suggestedConfidence = wasSuggested
    ? suggestions[suggestedIndex].confidence
    : null;
  const suggestedRank = wasSuggested ? suggestedIndex : null;

  // 1. Create junction document
  const connectionRef = ctx.db.collection("fileConnections").doc();
  const connectionData: Record<string, unknown> = {
    fileId,
    transactionId,
    userId: ctx.userId,
    connectionType,
    matchConfidence: matchConfidence ?? null,
    wasSuggested,
    suggestedConfidence,
    suggestedRank,
    createdAt: now,
  };

  // Add source tracking fields if provided
  if (sourceInfo?.sourceType) {
    connectionData.sourceType = sourceInfo.sourceType;
  }
  if (sourceInfo?.searchPattern) {
    connectionData.searchPattern = sourceInfo.searchPattern;
  }
  if (sourceInfo?.gmailIntegrationId) {
    connectionData.gmailIntegrationId = sourceInfo.gmailIntegrationId;
  }
  if (sourceInfo?.gmailIntegrationEmail) {
    connectionData.gmailIntegrationEmail = sourceInfo.gmailIntegrationEmail;
  }
  if (sourceInfo?.mailMessageId) {
    connectionData.mailMessageId = sourceInfo.mailMessageId;
  }
  if (sourceInfo?.gmailMessageFrom) {
    connectionData.gmailMessageFrom = sourceInfo.gmailMessageFrom;
  }
  if (sourceInfo?.gmailMessageFromName) {
    connectionData.gmailMessageFromName = sourceInfo.gmailMessageFromName;
  }
  if (sourceInfo?.resultType) {
    connectionData.resultType = sourceInfo.resultType;
  }

  batch.set(connectionRef, connectionData);

  // 2. Update file's transactionIds array
  const fileUpdate: Record<string, unknown> = {
    transactionIds: FieldValue.arrayUnion(transactionId),
    updatedAt: now,
    ...(copyCheck.clearMark ? CLEARED_COPY_MARK : {}),
  };

  // 3. Update transaction's fileIds array and mark as complete
  const actor = connectionType === "manual" ? "manual" : "auto";
  const sourceTypeLabel = sourceInfo?.sourceType || "search";
  const searchPattern = sourceInfo?.searchPattern?.trim();
  const summary = searchPattern
    ? `File "${fileData.fileName || fileId}" connected (found via ${sourceTypeLabel}: "${searchPattern}")`
    : `File "${fileData.fileName || fileId}" connected`;
  const transactionUpdate: Record<string, unknown> = {
    fileIds: FieldValue.arrayUnion(fileId),
    isComplete: true,
    updatedAt: now,
    automationHistory: FieldValue.arrayUnion({
      type: "file_connected",
      ranAt: now,
      status: "completed",
      actor,
      level: deriveActivityLevel({ type: "file_connected", actor }),
      fileId,
      fileName: fileData.fileName || null,
      confidence: matchConfidence ?? null,
      summary,
    }),
  };

  // 4. The payee rule (#550, ADR-0011): the File never overwrites the
  // Transaction's Partner and never takes it. An empty one is filled only when
  // every File on the Transaction, this one included, names the same Partner.
  const filePartnerId = fileData.partnerId;
  const transactionPartnerId = transactionData.partnerId;
  const payeeFileIds = Array.isArray(transactionData.fileIds)
    ? transactionData.fileIds.filter((id: string) => !reassignedAwayFileIds.has(id))
    : [];
  const payeeFill = await payeeFillForTransaction(ctx.db, ctx.userId, { ...transactionData, fileIds: payeeFileIds }, {
    connectingFileId: fileId,
    known: new Map([[fileId, fileData]]),
  });
  if (payeeFill) {
    Object.assign(transactionUpdate, payeeFill);
    console.log(`[connectFileToTransaction] Filled empty transaction partner with ${payeeFill.partnerId}`);
  }

  batch.update(fileRef, fileUpdate);
  batch.update(transactionRef, transactionUpdate);

  await batch.commit();

  console.log(`[connectFileToTransaction] Connected file ${fileId} to transaction ${transactionId}`);

  // === LEARN SOURCE PATTERNS ON PARTNER ===
  // After successful connection, store source patterns for future matching/search hints.
  const finalPartnerId = (transactionUpdate.partnerId as string | undefined) || transactionPartnerId || filePartnerId;
  const normalizedSearchPattern = sourceInfo?.searchPattern?.trim();

  if (finalPartnerId && (sourceInfo?.gmailMessageFrom || normalizedSearchPattern)) {
    const senderDomain = sourceInfo?.gmailMessageFrom
      ? extractEmailDomain(sourceInfo.gmailMessageFrom)
      : null;

    try {
      const partnerRef = ctx.db.collection("partners").doc(finalPartnerId);
      const partnerSnap = await partnerRef.get();

      if (partnerSnap.exists && partnerSnap.data()?.userId === ctx.userId) {
        const partnerData = partnerSnap.data()!;
        const nowTs = Timestamp.now();
        const updates: Record<string, unknown> = {
          updatedAt: nowTs,
        };
        let shouldUpdatePartner = false;

        const existingDomains: string[] = partnerData.emailDomains || [];
        if (senderDomain && !existingDomains.includes(senderDomain)) {
          updates.emailDomains = FieldValue.arrayUnion(senderDomain);
          updates.emailDomainsUpdatedAt = nowTs;
          shouldUpdatePartner = true;
          console.log(`[connectFileToTransaction] Learned email domain "${senderDomain}" for partner ${finalPartnerId}`);
        }

        const existingPatterns: PartnerFileSourcePattern[] = (partnerData.fileSourcePatterns || []) as PartnerFileSourcePattern[];
        const nextPatterns = [...existingPatterns];
        const filenameExample = typeof fileData.fileName === "string" ? fileData.fileName : undefined;
        let patternsChanged = false;

        // Legacy Gmail domain pattern learning (from:{domain}) with upsert semantics.
        if (senderDomain) {
          const domainPattern: PartnerFileSourcePattern = {
            sourceType: "gmail",
            pattern: `from:${senderDomain}`,
            integrationId: sourceInfo?.gmailIntegrationId || null,
            resultType: "gmail_attachment",
            confidence: 80,
            usageCount: 1,
            sourceTransactionIds: [transactionId],
            filenameExamples: filenameExample ? [filenameExample] : [],
            createdAt: nowTs,
            lastUsedAt: nowTs,
            fromDomain: senderDomain,
          };

          patternsChanged = upsertPattern(nextPatterns, domainPattern, transactionId, filenameExample, (p) => {
            const sameSource = (p.sourceType || "").toLowerCase() === "gmail";
            const sameIntegration = (p.integrationId || null) === (sourceInfo?.gmailIntegrationId || null);
            const patternMatch = (p.pattern || "").toLowerCase() === `from:${senderDomain}` || p.fromDomain === senderDomain;
            return sameSource && sameIntegration && patternMatch;
          }) || patternsChanged;
        }

        // Learn the actual search query that found this file.
        if (normalizedSearchPattern) {
          const querySourceType = sourceInfo?.sourceType || "gmail";
          const queryResultType = sourceInfo?.resultType || "gmail_attachment";
          const queryPattern: PartnerFileSourcePattern = {
            sourceType: querySourceType,
            pattern: normalizedSearchPattern,
            integrationId: sourceInfo?.gmailIntegrationId || null,
            resultType: queryResultType,
            confidence: 85,
            usageCount: 1,
            sourceTransactionIds: [transactionId],
            filenameExamples: filenameExample ? [filenameExample] : [],
            createdAt: nowTs,
            lastUsedAt: nowTs,
          };

          patternsChanged = upsertPattern(nextPatterns, queryPattern, transactionId, filenameExample, (p) => {
            const sameSource =
              (p.sourceType || "").toLowerCase() === querySourceType.toLowerCase();
            const samePattern =
              (p.pattern || "").toLowerCase() === normalizedSearchPattern.toLowerCase();
            const sameIntegration =
              (p.integrationId || null) === (sourceInfo?.gmailIntegrationId || null);
            const sameResultType =
              (p.resultType || null) === (queryResultType || null);
            return sameSource && samePattern && sameIntegration && sameResultType;
          }) || patternsChanged;
        }

        if (patternsChanged) {
          updates.fileSourcePatterns = nextPatterns;
          updates.fileSourcePatternsUpdatedAt = nowTs;
          shouldUpdatePartner = true;
        }

        if (shouldUpdatePartner) {
          await partnerRef.update(updates);
        }
      }
    } catch (learnErr) {
      // Don't fail the connection if pattern learning fails
      console.error(`[connectFileToTransaction] Failed to learn source patterns:`, learnErr);
    }
  }

  // === LEARN BILLING CYCLE ON PARTNER ===
  // yazzbert/FiBuKI-selfhost#166: a connect is the moment the partner's
  // history changed in the way the cycle is derived from — the document
  // just attached carries the invoice date the invoice-to-transaction
  // delay is computed from. So re-learn that one partner, history only,
  // no AI call. Awaited so the re-score it performs has landed before the
  // caller reads the connection back, and swallowed on failure for the
  // same reason as the pattern learning above: the connection is already
  // committed and must not be reported as failed.
  if (finalPartnerId) {
    try {
      await learnBillingCycleForPartner(ctx.db, ctx.userId, finalPartnerId);
    } catch (cycleErr) {
      console.error(`[connectFileToTransaction] Failed to learn billing cycle:`, cycleErr);
    }
  }

  return {
    success: true,
    connectionId: connectionRef.id,
    alreadyConnected: false,
    reassignedConnections,
  };
}

/**
 * Extract domain from email address
 */
function extractEmailDomain(email: string): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : null;
}

function upsertPattern(
  patterns: PartnerFileSourcePattern[],
  incoming: PartnerFileSourcePattern,
  transactionId: string,
  filenameExample: string | undefined,
  matcher: (pattern: PartnerFileSourcePattern) => boolean
): boolean {
  const nowTs = Timestamp.now();
  const index = patterns.findIndex(matcher);

  if (index >= 0) {
    const current = patterns[index];
    const mergedTxIds = appendUnique(current.sourceTransactionIds || [], transactionId, 20);
    const mergedFilenames = filenameExample
      ? appendUnique(current.filenameExamples || [], filenameExample, 10)
      : (current.filenameExamples || []);

    patterns[index] = {
      ...current,
      sourceType: incoming.sourceType || current.sourceType,
      pattern: incoming.pattern || current.pattern,
      integrationId: incoming.integrationId ?? current.integrationId ?? null,
      resultType: incoming.resultType || current.resultType,
      confidence: Math.max(current.confidence || 0, incoming.confidence || 0),
      usageCount: (current.usageCount || 0) + 1,
      sourceTransactionIds: mergedTxIds,
      filenameExamples: mergedFilenames,
      createdAt: current.createdAt || nowTs,
      lastUsedAt: nowTs,
      fromDomain: incoming.fromDomain || current.fromDomain,
    };
    return true;
  }

  patterns.push({
    ...incoming,
    usageCount: 1,
    sourceTransactionIds: [transactionId],
    filenameExamples: filenameExample ? [filenameExample] : incoming.filenameExamples || [],
    createdAt: incoming.createdAt || nowTs,
    lastUsedAt: nowTs,
  });
  return true;
}

function appendUnique(existing: string[], next: string, maxItems: number): string[] {
  const merged = [...existing.filter(Boolean)];
  if (!merged.includes(next)) {
    merged.push(next);
  }
  return merged.slice(-maxItems);
}
