/**
 * Learn Partner Resolution Preference
 *
 * Tracks how transactions with a partner are typically resolved (file vs no-receipt)
 * and updates the partner's resolution preference based on historical patterns.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

// ============ Types ============
// Local type definitions (mirrors types/partner.ts)
// Defined locally to avoid rootDir issues with importing from parent types folder

type NoReceiptCategoryId =
  | "bank-fees"
  | "interest"
  | "internal-transfers"
  | "payment-provider-settlements"
  | "taxes-government"
  | "payroll"
  | "private-personal"
  | "zero-value"
  | "receipt-lost";

type PartnerResolutionType = "file_required" | "no_receipt" | "mixed" | "unknown";

interface PartnerResolutionStats {
  fileCount: number;
  noReceiptCount: number;
  updatedAt: Timestamp;
}

interface PartnerResolutionPreference {
  type: PartnerResolutionType;
  confidence: number;
  preferredNoReceiptCategoryId?: string | null;
  preferredNoReceiptCategoryTemplateId?: NoReceiptCategoryId | null;
  stats: PartnerResolutionStats;
}

/**
 * Thresholds for resolution type determination
 */
const THRESHOLDS = {
  /** Minimum completed transactions before setting a preference */
  MIN_SAMPLE_SIZE: 3,
  /** Percentage threshold to consider partner as "mixed" (both types used) */
  MIXED_THRESHOLD: 0.2, // >20% of transactions use minority type
  /** Base confidence when MIN_SAMPLE_SIZE is reached */
  BASE_CONFIDENCE: 60,
  /** Maximum achievable confidence */
  MAX_CONFIDENCE: 95,
};

/**
 * Calculate resolution type and confidence from stats
 */
export function calculateResolutionType(stats: PartnerResolutionStats): {
  type: PartnerResolutionType;
  confidence: number;
} {
  const total = stats.fileCount + stats.noReceiptCount;

  // Not enough data yet
  if (total < THRESHOLDS.MIN_SAMPLE_SIZE) {
    return { type: "unknown", confidence: 0 };
  }

  const fileRatio = stats.fileCount / total;
  const noReceiptRatio = stats.noReceiptCount / total;
  const minorityRatio = Math.min(fileRatio, noReceiptRatio);

  // Confidence increases with sample size (logarithmic)
  // 3 transactions = 60%, 10 = ~75%, 30 = ~82%, 100 = ~90%
  const sampleBoost = Math.log10(total) * 15;
  let confidence = Math.min(
    THRESHOLDS.MAX_CONFIDENCE,
    THRESHOLDS.BASE_CONFIDENCE + sampleBoost
  );

  // If significant usage of both types, partner is "mixed"
  if (minorityRatio >= THRESHOLDS.MIXED_THRESHOLD) {
    // Mixed partners get lower confidence (behavior is less predictable)
    return {
      type: "mixed",
      confidence: Math.max(50, Math.round(confidence - 15)),
    };
  }

  // Clear preference for one type
  const type: PartnerResolutionType =
    fileRatio > noReceiptRatio ? "file_required" : "no_receipt";
  return { type, confidence: Math.round(confidence) };
}

/**
 * Update a partner's resolution stats when a transaction is completed.
 *
 * Called from onTransactionUpdate when isComplete changes to true.
 *
 * @param userId - The user who owns the partner
 * @param partnerId - The partner ID to update
 * @param resolvedWith - How the transaction was resolved ("file" or "no_receipt")
 * @param noReceiptCategoryId - The category ID if resolved with no-receipt
 */
export async function updatePartnerResolutionStats(
  userId: string,
  partnerId: string,
  resolvedWith: "file" | "no_receipt",
  noReceiptCategoryId: string | null
): Promise<void> {
  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerDoc = await partnerRef.get();

  if (!partnerDoc.exists) {
    console.log(
      `[learnPartnerResolution] Partner ${partnerId} not found, skipping`
    );
    return;
  }

  const partner = partnerDoc.data()!;

  // Verify ownership
  if (partner.userId !== userId) {
    console.log(
      `[learnPartnerResolution] Partner ${partnerId} not owned by user ${userId}, skipping`
    );
    return;
  }

  // Get current stats or initialize
  const currentStats = partner.resolutionPreference?.stats || {
    fileCount: 0,
    noReceiptCount: 0,
  };

  // Update stats
  const newStats: PartnerResolutionStats = {
    fileCount: currentStats.fileCount + (resolvedWith === "file" ? 1 : 0),
    noReceiptCount:
      currentStats.noReceiptCount + (resolvedWith === "no_receipt" ? 1 : 0),
    updatedAt: Timestamp.now(),
  };

  // Calculate new type and confidence
  const { type, confidence } = calculateResolutionType(newStats);

  // Build new preference
  const newPreference: PartnerResolutionPreference = {
    type,
    confidence,
    stats: newStats,
    // Track preferred no-receipt category (use most recent if no_receipt)
    preferredNoReceiptCategoryId:
      resolvedWith === "no_receipt" && noReceiptCategoryId
        ? noReceiptCategoryId
        : partner.resolutionPreference?.preferredNoReceiptCategoryId || null,
    preferredNoReceiptCategoryTemplateId:
      partner.resolutionPreference?.preferredNoReceiptCategoryTemplateId ||
      null,
  };

  // Get template ID if we have a category ID but no template ID
  if (
    newPreference.preferredNoReceiptCategoryId &&
    !newPreference.preferredNoReceiptCategoryTemplateId
  ) {
    try {
      const categoryDoc = await db
        .collection("noReceiptCategories")
        .doc(newPreference.preferredNoReceiptCategoryId)
        .get();
      if (categoryDoc.exists) {
        newPreference.preferredNoReceiptCategoryTemplateId =
          categoryDoc.data()?.templateId || null;
      }
    } catch (err) {
      console.error(
        `[learnPartnerResolution] Failed to fetch category ${newPreference.preferredNoReceiptCategoryId}:`,
        err
      );
    }
  }

  // Update partner
  await partnerRef.update({
    resolutionPreference: newPreference,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(
    `[learnPartnerResolution] Updated partner ${partnerId}: ` +
      `${type} (${confidence}%) - files: ${newStats.fileCount}, noReceipt: ${newStats.noReceiptCount}`
  );
}
