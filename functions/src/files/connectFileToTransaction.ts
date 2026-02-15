/**
 * Connect a file to a transaction (many-to-many relationship)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  cancelFileWorkersForTransaction,
  cancelTransactionWorkersForFile,
  cancelPrecisionSearchForTransaction,
} from "../utils/cancelWorkers";
import { deriveActivityLevel } from "../utils/activityLevel";

interface FileConnectionSourceInfo {
  sourceType?: string;
  searchPattern?: string;
  gmailIntegrationId?: string;
  gmailIntegrationEmail?: string;
  gmailMessageId?: string;
  gmailMessageFrom?: string;
  gmailMessageFromName?: string;
  resultType?: string;
}

interface ConnectFileRequest {
  fileId: string;
  transactionId: string;
  connectionType?: "manual" | "auto_matched";
  matchConfidence?: number;
  sourceInfo?: FileConnectionSourceInfo;
}

interface ConnectFileResponse {
  success: boolean;
  connectionId: string;
  alreadyConnected: boolean;
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
>(
  { name: "connectFileToTransaction" },
  async (ctx, request) => {
    const {
      fileId,
      transactionId,
      connectionType = "manual",
      matchConfidence,
      sourceInfo,
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
    if (sourceInfo?.gmailMessageId) {
      connectionData.gmailMessageId = sourceInfo.gmailMessageId;
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

    // 4. Partner sync logic - FILE TAKES PRECEDENCE (it's the actual document)
    // Exception: Manual assignments on transaction are respected
    //
    // Priority (highest to lowest):
    // 1. Manual assignment on transaction (user explicitly chose) - always respected
    // 2. File's partner (actual document with extracted company name)
    // 3. Transaction's auto-matched partner (bank data guessing)
    //
    // We store the original transaction partner as bankPartnerId for audit trail
    const filePartnerId = fileData.partnerId;
    const filePartnerConfidence = fileData.partnerMatchConfidence ?? 0;
    const transactionPartnerId = transactionData.partnerId;
    const transactionPartnerMatchedBy = transactionData.partnerMatchedBy;
    const transactionWasManual = transactionPartnerMatchedBy === "manual";

    if (filePartnerId && !transactionPartnerId) {
      // File has partner, transaction doesn't -> sync to transaction
      transactionUpdate.partnerId = filePartnerId;
      transactionUpdate.partnerType = fileData.partnerType ?? "user";
      transactionUpdate.partnerMatchConfidence = filePartnerConfidence;
      transactionUpdate.partnerMatchedBy = "auto"; // Synced from file
      console.log(`[connectFileToTransaction] Synced partner ${filePartnerId} from file to transaction`);
    } else if (transactionPartnerId && !filePartnerId) {
      // Transaction has partner, file doesn't -> sync to file
      fileUpdate.partnerId = transactionPartnerId;
      fileUpdate.partnerType = transactionData.partnerType ?? "user";
      fileUpdate.partnerMatchConfidence = transactionData.partnerMatchConfidence ?? 0;
      console.log(`[connectFileToTransaction] Synced partner ${transactionPartnerId} from transaction to file`);
    } else if (filePartnerId && transactionPartnerId && filePartnerId !== transactionPartnerId) {
      // Both have different partners - FILE WINS unless transaction was manual
      if (transactionWasManual) {
        // Respect manual assignment - sync transaction's partner to file instead
        fileUpdate.partnerId = transactionPartnerId;
        fileUpdate.partnerType = transactionData.partnerType ?? "user";
        fileUpdate.partnerMatchConfidence = transactionData.partnerMatchConfidence ?? 0;
        console.log(`[connectFileToTransaction] Transaction partner ${transactionPartnerId} (manual) respected, synced to file`);
      } else {
        // File wins - store original as bankPartnerId for audit trail
        transactionUpdate.bankPartnerId = transactionPartnerId;
        transactionUpdate.bankPartnerType = transactionData.partnerType ?? null;
        transactionUpdate.bankPartnerMatchedBy = transactionPartnerMatchedBy ?? null;
        transactionUpdate.bankPartnerMatchConfidence = transactionData.partnerMatchConfidence ?? null;
        // Override with file's partner
        transactionUpdate.partnerId = filePartnerId;
        transactionUpdate.partnerType = fileData.partnerType ?? "user";
        transactionUpdate.partnerMatchConfidence = filePartnerConfidence;
        transactionUpdate.partnerMatchedBy = "auto"; // Synced from file
        console.log(`[connectFileToTransaction] File partner ${filePartnerId} wins over transaction partner ${transactionPartnerId} (stored as bankPartnerId)`);
      }
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

    return {
      success: true,
      connectionId: connectionRef.id,
      alreadyConnected: false,
    };
  }
);

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
