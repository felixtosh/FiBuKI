"use strict";
/**
 * Server-side billing config.
 * Contains plan definitions, Stripe mapping, and shared billing types.
 *
 * NOTE: Types and PLANS are duplicated from /types/billing.ts for the frontend.
 * Keep both in sync when making changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRIAL_TRANSACTION_LIMIT = exports.TRIAL_DURATION_DAYS = exports.STRIPE_PRICE_IDS = exports.PLANS = exports.USER_TOKEN_RATE_PER_100K_EUR = exports.REFERRAL_COUPON_ID = void 0;
exports.getStripeMode = getStripeMode;
exports.getStripePrices = getStripePrices;
exports.getStripeProducts = getStripeProducts;
exports.hasFeature = hasFeature;
exports.getTrialStatus = getTrialStatus;
exports.mapLegacyPlan = mapLegacyPlan;
exports.createDefaultSubscriptionData = createDefaultSubscriptionData;
// Referral coupon ID in Stripe
exports.REFERRAL_COUPON_ID = "referral_20_off_yearly";
/** User-facing billing rate: EUR per 100,000 total tokens */
exports.USER_TOKEN_RATE_PER_100K_EUR = 0.35;
// =============================================================================
// PLANS Config
// =============================================================================
// Feature sets for reuse
const NO_AI_FEATURES = {
    fileUpload: false,
    aiMatching: false,
    aiExtraction: false,
    gmailIntegration: false,
    partnerIntelligence: false,
    chatAssistant: false,
    apiAccess: true,
    mcpAccess: true,
    bmdExport: false,
};
const SMART_FEATURES = {
    fileUpload: true,
    aiMatching: true,
    aiExtraction: true,
    gmailIntegration: true,
    partnerIntelligence: true,
    chatAssistant: true,
    apiAccess: true,
    mcpAccess: true,
    bmdExport: false,
};
const PRO_FEATURES = {
    ...SMART_FEATURES,
    bmdExport: true,
};
exports.PLANS = {
    free: {
        id: "free",
        name: "Free",
        monthlyPriceEur: 0,
        transactionLimit: 50,
        aiFairUseLimitEur: 0,
        overageAllowed: false,
        features: [
            "50 transactions/month",
            "Bank data access",
        ],
        planFeatures: NO_AI_FEATURES,
        rateLimit: { perMinute: 10, perHour: 100 },
    },
    data: {
        id: "data",
        name: "Data",
        monthlyPriceEur: 9.99,
        transactionLimit: 200,
        aiFairUseLimitEur: 0,
        overageAllowed: false,
        features: [
            "200 transactions/month",
            "Bank data API & MCP access",
            "CSV/JSON export",
            "Unlimited bank accounts",
        ],
        planFeatures: NO_AI_FEATURES,
        rateLimit: { perMinute: 60, perHour: 1000 },
    },
    smart: {
        id: "smart",
        name: "Smart",
        monthlyPriceEur: 19,
        transactionLimit: 500,
        aiFairUseLimitEur: 8.0,
        overageAllowed: true,
        features: [
            "500 transactions/month",
            "Everything in Data",
            "AI matching & extraction",
            "Gmail integration",
            "Partner intelligence",
            "Chat assistant",
            "8.00 EUR AI budget",
        ],
        planFeatures: SMART_FEATURES,
        rateLimit: { perMinute: 120, perHour: 5000 },
    },
    pro: {
        id: "pro",
        name: "Pro",
        monthlyPriceEur: 39,
        transactionLimit: 1000,
        aiFairUseLimitEur: 20.0,
        overageAllowed: true,
        features: [
            "1000 transactions/month",
            "Everything in Smart",
            "BMD/NTCS export",
            "20.00 EUR AI budget",
            "Priority support",
        ],
        planFeatures: PRO_FEATURES,
        rateLimit: { perMinute: 120, perHour: 5000 },
    },
    // Legacy tiers (migration only)
    starter: {
        id: "starter",
        name: "Starter (Legacy)",
        monthlyPriceEur: 9,
        transactionLimit: 100,
        aiFairUseLimitEur: 3.0,
        overageAllowed: true,
        features: [
            "100 transactions/month",
            "Partner intelligence",
            "3.00 EUR AI budget",
        ],
        planFeatures: NO_AI_FEATURES,
        rateLimit: { perMinute: 60, perHour: 1000 },
    },
    business: {
        id: "business",
        name: "Business (Legacy)",
        monthlyPriceEur: 19,
        transactionLimit: 200,
        aiFairUseLimitEur: 8.0,
        overageAllowed: true,
        features: [
            "200 transactions/month",
            "Gmail integration",
            "8.00 EUR AI budget",
        ],
        planFeatures: SMART_FEATURES,
        rateLimit: { perMinute: 120, perHour: 5000 },
    },
};
const STRIPE_PRICES_TEST = {
    free: { monthly: null, yearly: null },
    // New tiers (set after creating Stripe products)
    data: { monthly: null, yearly: null },
    smart: { monthly: null, yearly: null },
    pro: {
        monthly: "price_1SxutZK7O16U1uWZ4odK5F9a",
        yearly: "price_1SxutaK7O16U1uWZuZalUuXf",
    },
    // Legacy (still active for existing subscribers)
    starter: {
        monthly: "price_1SxutXK7O16U1uWZ4V9IBlkz",
        yearly: "price_1SxutYK7O16U1uWZbhVsldZl",
    },
    business: {
        monthly: "price_1SxutYK7O16U1uWZSmSrAk5K",
        yearly: "price_1SxutZK7O16U1uWZtjbJ0L8O",
    },
};
const STRIPE_PRICES_LIVE = {
    free: { monthly: null, yearly: null },
    data: { monthly: null, yearly: null }, // Set after live Stripe setup
    smart: { monthly: null, yearly: null },
    pro: { monthly: null, yearly: null },
    starter: { monthly: null, yearly: null },
    business: { monthly: null, yearly: null },
};
const STRIPE_PRODUCTS_TEST = {
    // New tiers
    data: null, // Set after creating Stripe products
    smart: null,
    pro: "prod_TvmSLlqGa56ZiK",
    aiCredits: "prod_TvmSY8TrGSA3Vx",
    // Legacy
    starter: "prod_TvmSfAEEE6fxfl",
    business: "prod_TvmSHZCCrRSrUc",
};
const STRIPE_PRODUCTS_LIVE = {
    data: null, // Set after live Stripe setup
    smart: null,
    pro: null,
    aiCredits: null,
    starter: null,
    business: null,
};
/** Detect Stripe mode from the secret key prefix. */
function getStripeMode(secretKey) {
    return secretKey.startsWith("sk_test_") ? "test" : "live";
}
/** Get price IDs for the current Stripe mode. */
function getStripePrices(secretKey) {
    return getStripeMode(secretKey) === "test" ? STRIPE_PRICES_TEST : STRIPE_PRICES_LIVE;
}
/** Get product IDs for the current Stripe mode. */
function getStripeProducts(secretKey) {
    return getStripeMode(secretKey) === "test" ? STRIPE_PRODUCTS_TEST : STRIPE_PRODUCTS_LIVE;
}
// Legacy export for backward compat (tests, etc.) — defaults to test
exports.STRIPE_PRICE_IDS = STRIPE_PRICES_TEST;
// =============================================================================
// Trial Constants
// =============================================================================
/** Trial duration in days */
exports.TRIAL_DURATION_DAYS = 60; // ~2 months
/** Max transactions before trial expires */
exports.TRIAL_TRANSACTION_LIMIT = 200;
// =============================================================================
// Feature Helpers
// =============================================================================
/**
 * Check if a plan has a specific feature.
 * For legacy starter plans with grandfathering, checks the grandfatheredUntil date.
 */
function hasFeature(planId, feature, grandfatheredUntil) {
    const plan = exports.PLANS[planId];
    if (!plan)
        return false;
    // Legacy starter users get AI features during grandfathering period
    if (planId === "starter" && grandfatheredUntil) {
        if (new Date() < grandfatheredUntil) {
            return exports.PLANS.smart.planFeatures[feature];
        }
    }
    return plan.planFeatures[feature];
}
/**
 * Check trial status from subscription data.
 */
function getTrialStatus(sub) {
    if (sub.trialExpired) {
        return { isOnTrial: false, trialDaysRemaining: 0, trialTransactionsRemaining: 0, trialExpired: true };
    }
    if (!sub.trialStartedAt) {
        return { isOnTrial: false, trialDaysRemaining: 0, trialTransactionsRemaining: 0, trialExpired: false };
    }
    const startDate = sub.trialStartedAt.toDate ? sub.trialStartedAt.toDate() : new Date(sub.trialStartedAt);
    const now = new Date();
    const daysSinceStart = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, exports.TRIAL_DURATION_DAYS - daysSinceStart);
    const txCount = sub.trialTransactionCount ?? 0;
    const txRemaining = Math.max(0, exports.TRIAL_TRANSACTION_LIMIT - txCount);
    const expired = daysRemaining <= 0 || txRemaining <= 0;
    return {
        isOnTrial: !expired,
        trialDaysRemaining: daysRemaining,
        trialTransactionsRemaining: txRemaining,
        trialExpired: expired,
    };
}
/**
 * Map legacy plan IDs to their new equivalents.
 */
function mapLegacyPlan(planId) {
    switch (planId) {
        case "starter": return "data";
        case "business": return "smart";
        default: return planId;
    }
}
/**
 * Create a default subscription doc for a new/free user.
 */
function createDefaultSubscriptionData(userId) {
    const plan = exports.PLANS.free;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return {
        userId,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: "none",
        plan: "free",
        billingPeriod: "monthly",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        aiFairUseLimitEur: plan.aiFairUseLimitEur,
        aiUsageCurrentPeriodEur: 0,
        aiCreditsEur: 0,
        aiOverageCapEur: 0,
        aiOverageCurrentPeriodEur: 0,
        aiPaused: false,
        aiWarning90Sent: false,
        aiWarning100Sent: false,
        transactionCountCurrentMonth: 0,
        transactionCountMonth: yearMonth,
        createdAt: now,
        updatedAt: now,
    };
}
//# sourceMappingURL=config.js.map