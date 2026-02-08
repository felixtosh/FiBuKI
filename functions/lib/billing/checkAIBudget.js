"use strict";
/**
 * AI Budget Check Utility
 *
 * Single-read check to determine if a user can consume AI resources.
 * Priority chain: fair use -> credits -> overage -> denied.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAIBudget = checkAIBudget;
const firestore_1 = require("firebase-admin/firestore");
const config_1 = require("./config");
async function checkAIBudget(userId, isAdmin = false) {
    if (isAdmin) {
        return { allowed: true, source: "fair_use", remainingEur: Infinity, paused: false };
    }
    const db = (0, firestore_1.getFirestore)();
    const subDoc = await db.collection("subscriptions").doc(userId).get();
    if (!subDoc.exists) {
        // No subscription doc = free tier with full budget available
        const freePlan = config_1.PLANS.free;
        return {
            allowed: true,
            source: "fair_use",
            remainingEur: freePlan.aiFairUseLimitEur,
            paused: false,
        };
    }
    const sub = subDoc.data();
    // Admin override: free_plan users have unlimited AI budget
    if (sub.adminOverride === "free_plan") {
        return { allowed: true, source: "fair_use", remainingEur: Infinity, paused: false };
    }
    // Already paused
    if (sub.aiPaused) {
        return {
            allowed: false,
            source: "none",
            remainingEur: 0,
            paused: true,
        };
    }
    const fairUseLimit = sub.aiFairUseLimitEur;
    const currentUsage = sub.aiUsageCurrentPeriodEur;
    const credits = sub.aiCreditsEur;
    const overageCap = sub.aiOverageCapEur;
    const currentOverage = sub.aiOverageCurrentPeriodEur;
    const plan = (sub.plan || "free");
    const overageAllowed = config_1.PLANS[plan]?.overageAllowed ?? false;
    // 1. Fair use remaining?
    const fairUseRemaining = fairUseLimit - currentUsage;
    if (fairUseRemaining > 0.001) {
        return {
            allowed: true,
            source: "fair_use",
            remainingEur: fairUseRemaining,
            paused: false,
        };
    }
    // 2. Prepaid credits remaining?
    if (credits > 0.001) {
        return {
            allowed: true,
            source: "credits",
            remainingEur: credits,
            paused: false,
        };
    }
    // 3. Overage cap has room?
    if (overageAllowed && overageCap > 0) {
        const overageRemaining = overageCap - currentOverage;
        if (overageRemaining > 0.001) {
            return {
                allowed: true,
                source: "overage",
                remainingEur: overageRemaining,
                paused: false,
            };
        }
    }
    // Nothing left
    return {
        allowed: false,
        source: "none",
        remainingEur: 0,
        paused: false,
    };
}
//# sourceMappingURL=checkAIBudget.js.map