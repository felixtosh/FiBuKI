"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USER_TOKEN_RATE_PER_100K_EUR = exports.PLANS = void 0;
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
        transactionLimit: 200,
        aiFairUseLimitEur: 3.0,
        overageAllowed: true,
        features: [
            "200 transactions/month",
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
        transactionLimit: 1000,
        aiFairUseLimitEur: 8.0,
        overageAllowed: true,
        features: [
            "1,000 transactions/month",
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
        transactionLimit: 5000,
        aiFairUseLimitEur: 20.0,
        overageAllowed: true,
        features: [
            "5,000 transactions/month",
            "Everything in Business",
            "BMD/NTCS export",
            "20.00 EUR AI budget",
            "API access",
        ],
    },
};
// =============================================================================
// AI Billing Rate (EUR per 100k total tokens)
// =============================================================================
/** User-facing billing rate: EUR per 100,000 total tokens */
exports.USER_TOKEN_RATE_PER_100K_EUR = 0.35;
//# sourceMappingURL=billing.js.map