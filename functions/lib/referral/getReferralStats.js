"use strict";
/**
 * Get referral statistics for the authenticated user's dashboard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReferralStatsCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const config_1 = require("../billing/config");
exports.getReferralStatsCallable = (0, createCallable_1.createCallable)({ name: "getReferralStats" }, async (ctx) => {
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
                totalCreditsEur += config_1.PLANS.smart.monthlyPriceEur;
            }
        }
        else if (data.status === "pending") {
            pendingCredits++;
        }
    }
    return {
        totalReferred: conversions.size,
        converted,
        pendingCredits,
        totalCreditsEur,
    };
});
//# sourceMappingURL=getReferralStats.js.map