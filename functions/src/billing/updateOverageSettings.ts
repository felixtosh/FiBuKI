/**
 * Update overage settings for a user's subscription.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { PLANS } from "./config";
import type { PlanId } from "./config";

interface UpdateOverageSettingsRequest {
  overageCapEur: number;
}

interface UpdateOverageSettingsResponse {
  success: boolean;
  aiPaused: boolean;
}

export const updateOverageSettingsCallable = createCallable<
  UpdateOverageSettingsRequest,
  UpdateOverageSettingsResponse
>(
  { name: "updateOverageSettings" },
  async (ctx, request) => {
    const { overageCapEur } = request;

    if (typeof overageCapEur !== "number" || overageCapEur < 0 || overageCapEur > 200) {
      throw new HttpsError("invalid-argument", "overageCapEur must be between 0 and 200");
    }

    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();

    if (!subDoc.exists) {
      throw new HttpsError("not-found", "No subscription found");
    }

    const sub = subDoc.data()!;
    const plan = (sub.plan || "free") as PlanId;

    if (!PLANS[plan]?.overageAllowed) {
      throw new HttpsError(
        "failed-precondition",
        "Overage is not available on the free plan. Please upgrade to enable overage."
      );
    }

    // Check if we should un-pause AI
    let aiPaused = sub.aiPaused as boolean;
    if (aiPaused && overageCapEur > 0) {
      const currentOverage = (sub.aiOverageCurrentPeriodEur as number) || 0;
      if (overageCapEur > currentOverage) {
        aiPaused = false; // Room available now
      }
    }

    await subRef.update({
      aiOverageCapEur: overageCapEur,
      aiPaused,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, aiPaused };
  }
);
