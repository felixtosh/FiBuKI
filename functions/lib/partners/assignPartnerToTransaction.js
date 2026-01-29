"use strict";
/**
 * Assign a partner to a transaction
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignPartnerToTransactionCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const cancelWorkers_1 = require("../utils/cancelWorkers");
exports.assignPartnerToTransactionCallable = (0, createCallable_1.createCallable)({ name: "assignPartnerToTransaction" }, async (ctx, request) => {
    const { transactionId, partnerId, partnerType, matchedBy, confidence } = request;
    if (!transactionId) {
        throw new createCallable_1.HttpsError("invalid-argument", "transactionId is required");
    }
    if (!partnerId) {
        throw new createCallable_1.HttpsError("invalid-argument", "partnerId is required");
    }
    if (!partnerType) {
        throw new createCallable_1.HttpsError("invalid-argument", "partnerType is required");
    }
    if (!matchedBy) {
        throw new createCallable_1.HttpsError("invalid-argument", "matchedBy is required");
    }
    // Verify transaction ownership
    const transactionRef = ctx.db.collection("transactions").doc(transactionId);
    const transactionSnap = await transactionRef.get();
    if (!transactionSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Transaction not found");
    }
    const txData = transactionSnap.data();
    if (txData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Access denied");
    }
    // Verify partner exists - check correct collection based on type
    const collectionName = partnerType === "global" ? "globalPartners" : "partners";
    const partnerRef = ctx.db.collection(collectionName).doc(partnerId);
    const partnerSnap = await partnerRef.get();
    if (!partnerSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Partner not found");
    }
    // For user partners, verify ownership
    const partnerData = partnerSnap.data();
    if (partnerType === "user" && partnerData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Partner access denied");
    }
    // Check if user previously rejected this partner for this transaction
    // Only block for auto/ai matches - manual/suggestion assignments are deliberate user overrides
    // manualRemovals is an array of { transactionId: string, ... }
    const manualRemovals = partnerData.manualRemovals || [];
    const wasRejected = manualRemovals.some((r) => r.transactionId === transactionId);
    if (wasRejected && (matchedBy === "auto" || matchedBy === "ai")) {
        console.log(`[assignPartnerToTransaction] Blocked: Partner ${partnerId} was previously rejected for transaction ${transactionId} (matchedBy: ${matchedBy})`);
        throw new createCallable_1.HttpsError("failed-precondition", `Partner was previously rejected for this transaction. To reassign, first remove it from the partner's rejection list.`);
    }
    if (wasRejected) {
        // Manual/suggestion override of a previously rejected partner
        console.log(`[assignPartnerToTransaction] Manual override: Partner ${partnerId} was previously rejected but user is re-adding via ${matchedBy}`);
    }
    // Cancel running partner automation when user manually assigns or accepts suggestion
    if (matchedBy === "manual" || matchedBy === "suggestion") {
        (0, cancelWorkers_1.cancelPartnerWorkersForTransaction)(ctx.userId, transactionId).catch((err) => {
            console.error("[assignPartnerToTransaction] Failed to cancel partner workers:", err);
        });
    }
    // Update transaction with partner assignment
    await transactionRef.update({
        partnerId,
        partnerType,
        partnerMatchedBy: matchedBy,
        partnerMatchConfidence: confidence ?? null,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
    console.log(`[assignPartnerToTransaction] Assigned partner ${partnerId} to transaction ${transactionId}`, {
        userId: ctx.userId,
        partnerType,
        matchedBy,
    });
    // Trigger pattern learning for user/AI assignments
    // Manual, suggestion clicks, and AI assignments should inform pattern learning
    if ((matchedBy === "manual" || matchedBy === "suggestion" || matchedBy === "ai") && partnerType === "user") {
        try {
            const { learnPatternsForPartnersBatch } = await Promise.resolve().then(() => __importStar(require("../matching/learnPartnerPatterns")));
            // Run pattern learning in background (don't await)
            learnPatternsForPartnersBatch(ctx.userId, [partnerId])
                .then((results) => {
                console.log(`[assignPartnerToTransaction] Pattern learning completed:`, results);
            })
                .catch((err) => {
                console.error(`[assignPartnerToTransaction] Pattern learning failed:`, err);
            });
        }
        catch (err) {
            console.error(`[assignPartnerToTransaction] Failed to start pattern learning:`, err);
        }
    }
    // Trigger receipt search if transaction has no files attached AND no no-receipt category
    // This runs in background and creates a worker request for the frontend to process
    const hasFiles = txData.fileIds && txData.fileIds.length > 0;
    const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
    const previousPartnerId = txData.partnerId;
    const partnerChanged = previousPartnerId !== partnerId;
    // Skip receipt search if transaction is already complete (has file or no-receipt category)
    if (!hasFiles && !hasNoReceiptCategory && (partnerChanged || !previousPartnerId)) {
        try {
            const { queueReceiptSearchForTransaction } = await Promise.resolve().then(() => __importStar(require("../workers/runReceiptSearchForTransaction")));
            // Queue receipt search in background (don't await)
            queueReceiptSearchForTransaction({
                transactionId,
                userId: ctx.userId,
                partnerId,
            })
                .then((result) => {
                console.log(`[assignPartnerToTransaction] Receipt search queued:`, result);
            })
                .catch((err) => {
                console.error(`[assignPartnerToTransaction] Receipt search queue failed:`, err);
            });
        }
        catch (err) {
            console.error(`[assignPartnerToTransaction] Failed to queue receipt search:`, err);
        }
    }
    return { success: true };
});
//# sourceMappingURL=assignPartnerToTransaction.js.map