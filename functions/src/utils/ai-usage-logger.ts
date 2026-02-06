import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PLANS, USER_TOKEN_RATE_PER_100K_EUR } from "../billing/config";
import type { PlanId } from "../billing/config";

type AIFunction =
  | "chat"
  | "companyLookup"
  | "companyLookupSearch"
  | "patternLearning"
  | "patternVerification"
  | "categoryPatternLearning"
  | "categoryPatternVerification"
  | "columnMatching"
  | "extraction"
  | "classification"
  | "domainValidation"
  | "ocrParsing"
  | "partnerDedup"
  | "searchQueryGeneration"
  | "emailAnalysis"
  | "batchMatching"
  | "fileSearchQuery";

// Pricing per million tokens (USD) — used for internal cost tracking
const AI_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude models
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // Gemini models (via Vertex AI)
  "gemini-2.0-flash-lite-001": { input: 0.075, output: 0.30 },
  "gemini-2.0-flash-001": { input: 0.10, output: 0.40 },
  "gemini-2.5-flash-preview-05-20": { input: 0.15, output: 0.60 },
};

export interface AIUsageParams {
  function: AIFunction;
  model: string;
  inputTokens: number;
  outputTokens: number;
  metadata?: {
    partnerId?: string;
    sourceId?: string;
    fileId?: string;
    categoryId?: string;
    webSearchUsed?: boolean;
  } | null;
}

/**
 * Calculate estimated cost based on model pricing (USD, internal)
 */
export function calculateAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = AI_MODEL_PRICING[model] || AI_MODEL_PRICING["claude-sonnet-4-20250514"];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Calculate user-facing cost in EUR based on flat token rate.
 */
function calculateUserCostEur(inputTokens: number, outputTokens: number): number {
  const totalTokens = inputTokens + outputTokens;
  return (totalTokens / 100_000) * USER_TOKEN_RATE_PER_100K_EUR;
}

/**
 * Log AI usage to Firestore and accumulate budget on subscription doc.
 */
export async function logAIUsage(
  userId: string,
  params: AIUsageParams
): Promise<void> {
  const db = getFirestore();
  const cost = calculateAICost(params.model, params.inputTokens, params.outputTokens);
  const userCostEur = calculateUserCostEur(params.inputTokens, params.outputTokens);

  try {
    // 1. Log to aiUsage collection (existing behavior)
    await db.collection("aiUsage").add({
      userId,
      function: params.function,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedCost: cost,
      createdAt: FieldValue.serverTimestamp(),
      metadata: params.metadata || null,
    });

    console.log(`[AI Usage] ${params.function}`, {
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedCost: `$${cost.toFixed(4)}`,
      userCostEur: `€${userCostEur.toFixed(4)}`,
    });

    // 2. Accumulate budget on subscription doc (non-blocking)
    await accumulateBudget(db, userId, userCostEur);
  } catch (error) {
    // Don't fail the main request if logging fails
    console.error("[AI Usage] Failed to log usage:", error);
  }
}

/**
 * Accumulate AI spending on the subscription doc and check warning thresholds.
 *
 * Uses a Firestore transaction to prevent race conditions:
 * - Two concurrent AI calls can't both "see" remaining budget and double-spend
 * - Warning flags are checked-and-set atomically (no duplicate emails)
 * - Credits can't go negative from concurrent decrements
 */
async function accumulateBudget(
  db: FirebaseFirestore.Firestore,
  userId: string,
  costEur: number
): Promise<void> {
  const subRef = db.collection("subscriptions").doc(userId);

  const warningToSend = await db.runTransaction(async (tx) => {
    const subDoc = await tx.get(subRef);

    if (!subDoc.exists) {
      // No subscription doc — skip budget accumulation (user hasn't been migrated yet)
      return null;
    }

    const sub = subDoc.data()!;
    const fairUseLimit = sub.aiFairUseLimitEur as number;
    const currentUsage = sub.aiUsageCurrentPeriodEur as number;
    const credits = sub.aiCreditsEur as number;
    const overageCap = sub.aiOverageCapEur as number;
    const currentOverage = sub.aiOverageCurrentPeriodEur as number;
    const plan = (sub.plan || "free") as PlanId;
    const overageAllowed = PLANS[plan]?.overageAllowed ?? false;

    const fairUseRemaining = fairUseLimit - currentUsage;

    // Determine where to charge (all within transaction — consistent read + write)
    if (fairUseRemaining > 0.001) {
      tx.update(subRef, {
        aiUsageCurrentPeriodEur: currentUsage + costEur,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (credits > 0.001) {
      tx.update(subRef, {
        aiCreditsEur: Math.max(0, credits - costEur),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (overageAllowed && overageCap > 0) {
      const overageRemaining = overageCap - currentOverage;
      if (overageRemaining > 0.001) {
        tx.update(subRef, {
          aiOverageCurrentPeriodEur: currentOverage + costEur,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(subRef, {
          aiPaused: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        console.log(`[AI Budget] User ${userId}: overage cap exhausted, AI paused`);
      }
    } else {
      tx.update(subRef, {
        aiUsageCurrentPeriodEur: currentUsage + costEur,
        aiPaused: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[AI Budget] User ${userId}: budget exhausted, AI paused`);
    }

    // Check warning thresholds (atomically within same transaction)
    const newUsage = currentUsage + costEur;
    const usagePercent = fairUseLimit > 0 ? (newUsage / fairUseLimit) * 100 : 100;

    if (usagePercent >= 100 && !sub.aiWarning100Sent) {
      tx.update(subRef, { aiWarning100Sent: true });
      return { percent: 100, usageEur: newUsage, limitEur: fairUseLimit };
    } else if (usagePercent >= 90 && !sub.aiWarning90Sent) {
      tx.update(subRef, { aiWarning90Sent: true });
      return { percent: 90, usageEur: newUsage, limitEur: fairUseLimit };
    }

    return null;
  });

  // Send warning email outside of transaction (side effect, fire-and-forget)
  if (warningToSend) {
    sendUsageWarningEmail(
      userId,
      warningToSend.percent,
      warningToSend.usageEur,
      warningToSend.limitEur
    ).catch((err) =>
      console.error(`[AI Budget] Failed to send ${warningToSend.percent}% warning:`, err)
    );
  }
}

/**
 * Lazy-load and send usage warning email to avoid circular imports.
 */
async function sendUsageWarningEmail(
  userId: string,
  percent: number,
  usageEur: number,
  limitEur: number
): Promise<void> {
  try {
    const { sendUsageWarning } = await import("../billing/sendUsageWarning");
    await sendUsageWarning(userId, percent, usageEur, limitEur);
  } catch (error) {
    console.error("[AI Budget] Failed to send warning email:", error);
  }
}
