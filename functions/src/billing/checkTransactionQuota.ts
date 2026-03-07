/**
 * Check if user has remaining transaction quota for the current month.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PLANS, getTrialStatus } from "./config";
import type { TransactionQuotaResult, PlanId } from "./config";

export async function checkTransactionQuota(
  userId: string,
  countToAdd: number = 1,
  isAdmin: boolean = false
): Promise<TransactionQuotaResult> {
  if (isAdmin) {
    return { allowed: true, currentCount: 0, limit: Infinity, remainingSlots: Infinity };
  }

  const db = getFirestore();
  const subRef = db.collection("subscriptions").doc(userId);
  const subDoc = await subRef.get();

  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  if (!subDoc.exists) {
    // No subscription doc = free tier
    const freePlan = PLANS.free;
    return {
      allowed: countToAdd <= freePlan.transactionLimit,
      currentCount: 0,
      limit: freePlan.transactionLimit,
      remainingSlots: freePlan.transactionLimit,
    };
  }

  const sub = subDoc.data()!;

  // Admin override: free_plan users have unlimited quota
  if (sub.adminOverride === "free_plan") {
    return { allowed: true, currentCount: 0, limit: Infinity, remainingSlots: Infinity };
  }

  const plan = (sub.plan || "free") as PlanId;
  const limit = PLANS[plan]?.transactionLimit ?? PLANS.free.transactionLimit;

  let currentCount = (sub.transactionCountCurrentMonth as number) || 0;
  const countMonth = (sub.transactionCountMonth as string) || "";

  // Reset if we're in a new month
  if (countMonth !== currentYearMonth) {
    currentCount = 0;
    await subRef.update({
      transactionCountCurrentMonth: 0,
      transactionCountMonth: currentYearMonth,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const remainingSlots = Math.max(0, limit - currentCount);

  return {
    allowed: countToAdd <= remainingSlots,
    currentCount,
    limit,
    remainingSlots,
  };
}

/**
 * Increment the transaction count after successful import.
 * Also increments trialTransactionCount if user is on trial.
 */
export async function incrementTransactionCount(
  userId: string,
  count: number
): Promise<void> {
  const db = getFirestore();
  const subRef = db.collection("subscriptions").doc(userId);
  const subDoc = await subRef.get();

  if (!subDoc.exists) return;

  const sub = subDoc.data()!;
  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const countMonth = (sub.transactionCountMonth as string) || "";

  // Build the update
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (countMonth !== currentYearMonth) {
    update.transactionCountCurrentMonth = count;
    update.transactionCountMonth = currentYearMonth;
  } else {
    update.transactionCountCurrentMonth = FieldValue.increment(count);
  }

  // Also increment trial transaction count if on trial
  const trialStatus = getTrialStatus(sub);
  if (trialStatus.isOnTrial) {
    update.trialTransactionCount = FieldValue.increment(count);
  }

  await subRef.update(update);
}
