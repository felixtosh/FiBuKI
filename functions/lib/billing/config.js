"use strict";
/**
 * Server-side billing config.
 * Contains plan definitions, Stripe mapping, and shared billing types.
 *
 * NOTE: Types and PLANS are duplicated from /types/billing.ts for the frontend.
 * Keep both in sync when making changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STRIPE_PRICE_IDS = exports.PLANS = exports.USER_TOKEN_RATE_PER_100K_EUR = void 0;
exports.getStripeMode = getStripeMode;
exports.getStripePrices = getStripePrices;
exports.getStripeProducts = getStripeProducts;
exports.createDefaultSubscriptionData = createDefaultSubscriptionData;
/** User-facing billing rate: EUR per 100,000 total tokens */
exports.USER_TOKEN_RATE_PER_100K_EUR = 0.35;
// =============================================================================
// PLANS Config
// =============================================================================
exports.PLANS = {
    free: {
        id: "free",
        name: "Free",
        monthlyPriceEur: 0,
        transactionLimit: 50,
        aiFairUseLimitEur: 0.5,
        overageAllowed: false,
        features: [
            "50 transactions/month",
            "File upload & extraction",
            "Basic auto-matching",
            "0.50 EUR AI budget",
        ],
    },
    starter: {
        id: "starter",
        name: "Starter",
        monthlyPriceEur: 9,
        transactionLimit: 100,
        aiFairUseLimitEur: 3.0,
        overageAllowed: true,
        features: [
            "100 transactions/month",
            "Everything in Free",
            "Partner intelligence",
            "3.00 EUR AI budget",
            "Overage & credits",
        ],
    },
    business: {
        id: "business",
        name: "Business",
        monthlyPriceEur: 19,
        transactionLimit: 200,
        aiFairUseLimitEur: 8.0,
        overageAllowed: true,
        features: [
            "200 transactions/month",
            "Everything in Starter",
            "Gmail integration",
            "8.00 EUR AI budget",
            "Priority matching",
        ],
    },
    pro: {
        id: "pro",
        name: "Pro",
        monthlyPriceEur: 39,
        transactionLimit: 500,
        aiFairUseLimitEur: 20.0,
        overageAllowed: true,
        features: [
            "500 transactions/month",
            "Everything in Business",
            "BMD/NTCS export",
            "20.00 EUR AI budget",
            "API access",
        ],
    },
};
const STRIPE_PRICES_TEST = {
    free: { monthly: null, yearly: null },
    starter: {
        monthly: "price_1SxutXK7O16U1uWZ4V9IBlkz",
        yearly: "price_1SxutYK7O16U1uWZbhVsldZl",
    },
    business: {
        monthly: "price_1SxutYK7O16U1uWZSmSrAk5K",
        yearly: "price_1SxutZK7O16U1uWZtjbJ0L8O",
    },
    pro: {
        monthly: "price_1SxutZK7O16U1uWZ4odK5F9a",
        yearly: "price_1SxutaK7O16U1uWZuZalUuXf",
    },
};
const STRIPE_PRICES_LIVE = {
    free: { monthly: null, yearly: null },
    starter: { monthly: null, yearly: null }, // Set after live Stripe setup
    business: { monthly: null, yearly: null },
    pro: { monthly: null, yearly: null },
};
const STRIPE_PRODUCTS_TEST = {
    starter: "prod_TvmSfAEEE6fxfl",
    business: "prod_TvmSHZCCrRSrUc",
    pro: "prod_TvmSLlqGa56ZiK",
    aiCredits: "prod_TvmSY8TrGSA3Vx",
};
const STRIPE_PRODUCTS_LIVE = {
    starter: null, // Set after live Stripe setup
    business: null,
    pro: null,
    aiCredits: null,
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