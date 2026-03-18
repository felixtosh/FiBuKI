/**
 * Get referral statistics for the authenticated user's dashboard.
 */

import { createCallable } from "../utils/createCallable";
import { PLANS } from "../billing/config";

interface GetReferralStatsResponse {
  totalReferred: number;
  converted: number;
  pendingCredits: number;
  totalCreditsEur: number;
}

export const getReferralStatsCallable = createCallable<
  void,
  GetReferralStatsResponse
>(
  { name: "getReferralStats" },
  async (ctx) => {
    const conversions = await ctx.db
      .collection("referralConversions")
      .where("referrerUserId", "==", ctx.userId)
      .get();

    let converted = 0;
    let pendingCredits = 0;
    let totalCreditsEur = 0;

    for (const doc of conversions.docs) {
      const data = doc.data();
      if (data.status === "converted") {
        converted++;
        if (data.referrerCreditApplied) {
          // Approximate credit amount (one month of their plan, default to smart)
          totalCreditsEur += PLANS.smart.monthlyPriceEur;
        }
      } else if (data.status === "pending") {
        pendingCredits++;
      }
    }

    return {
      totalReferred: conversions.size,
      converted,
      pendingCredits,
      totalCreditsEur,
    };
  }
);
