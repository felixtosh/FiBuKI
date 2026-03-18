/**
 * Server-side billing config.
 * Contains plan definitions, Stripe mapping, and shared billing types.
 *
 * NOTE: Types and PLANS are duplicated from /types/billing.ts for the frontend.
 * Keep both in sync when making changes.
 */

// =============================================================================
// Types (mirrored from /types/billing.ts)
// =============================================================================

// New plan IDs + legacy IDs kept during migration
export type PlanId =
  | "free"
  | "data"
  | "smart"
  | "pro"
  // Legacy (migration only — remove after all users migrated)
  | "starter"
  | "business";
export type BillingPeriod = "monthly" | "yearly";
export type StripeSubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "trialing"
  | "none";

export interface PlanFeatures {
  fileUpload: boolean;
  aiMatching: boolean;
  aiExtraction: boolean;
  gmailIntegration: boolean;
  partnerIntelligence: boolean;
  chatAssistant: boolean;
  apiAccess: boolean;
  mcpAccess: boolean;
  bmdExport: boolean;
}

export type PlanFeatureKey = keyof PlanFeatures;

export interface RateLimitConfig {
  perMinute: number;
  perHour: number;
}

export interface PlanConfig {
  id: PlanId;
  name: string;
  monthlyPriceEur: number;
  transactionLimit: number;
  aiFairUseLimitEur: number;
  overageAllowed: boolean;
  features: string[];
  planFeatures: PlanFeatures;
  rateLimit: RateLimitConfig;
}

export interface AIBudgetCheckResult {
  allowed: boolean;
  source: "fair_use" | "credits" | "overage" | "none";
  remainingEur: number;
  paused: boolean;
}

export interface TransactionQuotaResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remainingSlots: number;
}

export type AdminOverride = "free_plan" | "plan_tester" | null;
export type AutomationMode = "active" | "passive";

// Referral coupon ID in Stripe
export const REFERRAL_COUPON_ID = "referral_20_off_yearly";

/** User-facing billing rate: EUR per 100,000 total tokens */
export const USER_TOKEN_RATE_PER_100K_EUR = 0.35;

// =============================================================================
// PLANS Config
// =============================================================================

// Feature sets for reuse
const NO_AI_FEATURES: PlanFeatures = {
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

const SMART_FEATURES: PlanFeatures = {
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

const PRO_FEATURES: PlanFeatures = {
  ...SMART_FEATURES,
  bmdExport: true,
};

export const PLANS: Record<PlanId, PlanConfig> = {
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

// =============================================================================
// Stripe Price ID Mapping
//
// Mode is auto-detected from the Stripe secret key prefix:
//   sk_test_... → test prices, sk_live_... → live prices
// No env vars needed — just switch the STRIPE_SECRET_KEY secret.
// =============================================================================

type StripePriceMap = Record<PlanId, Record<BillingPeriod, string | null>>;

const STRIPE_PRICES_TEST: StripePriceMap = {
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

const STRIPE_PRICES_LIVE: StripePriceMap = {
  free: { monthly: null, yearly: null },
  data: { monthly: null, yearly: null }, // Set after live Stripe setup
  smart: { monthly: null, yearly: null },
  pro: { monthly: null, yearly: null },
  starter: { monthly: null, yearly: null },
  business: { monthly: null, yearly: null },
};

const STRIPE_PRODUCTS_TEST = {
  // New tiers
  data: null as string | null, // Set after creating Stripe products
  smart: null as string | null,
  pro: "prod_TvmSLlqGa56ZiK",
  aiCredits: "prod_TvmSY8TrGSA3Vx",
  // Legacy
  starter: "prod_TvmSfAEEE6fxfl",
  business: "prod_TvmSHZCCrRSrUc",
};

const STRIPE_PRODUCTS_LIVE = {
  data: null as string | null, // Set after live Stripe setup
  smart: null as string | null,
  pro: null as string | null,
  aiCredits: null as string | null,
  starter: null as string | null,
  business: null as string | null,
};

/** Detect Stripe mode from the secret key prefix. */
export function getStripeMode(secretKey: string): "test" | "live" {
  return secretKey.startsWith("sk_test_") ? "test" : "live";
}

/** Get price IDs for the current Stripe mode. */
export function getStripePrices(secretKey: string): StripePriceMap {
  return getStripeMode(secretKey) === "test" ? STRIPE_PRICES_TEST : STRIPE_PRICES_LIVE;
}

/** Get product IDs for the current Stripe mode. */
export function getStripeProducts(secretKey: string) {
  return getStripeMode(secretKey) === "test" ? STRIPE_PRODUCTS_TEST : STRIPE_PRODUCTS_LIVE;
}

// Legacy export for backward compat (tests, etc.) — defaults to test
export const STRIPE_PRICE_IDS = STRIPE_PRICES_TEST;

// =============================================================================
// Trial Constants
// =============================================================================

/** Trial duration in days */
export const TRIAL_DURATION_DAYS = 60; // ~2 months
/** Max transactions before trial expires */
export const TRIAL_TRANSACTION_LIMIT = 200;

// =============================================================================
// Feature Helpers
// =============================================================================

/**
 * Check if a plan has a specific feature.
 * For legacy starter plans with grandfathering, checks the grandfatheredUntil date.
 */
export function hasFeature(
  planId: PlanId,
  feature: PlanFeatureKey,
  grandfatheredUntil?: Date | null
): boolean {
  const plan = PLANS[planId];
  if (!plan) return false;

  // Legacy starter users get AI features during grandfathering period
  if (planId === "starter" && grandfatheredUntil) {
    if (new Date() < grandfatheredUntil) {
      return PLANS.smart.planFeatures[feature];
    }
  }

  return plan.planFeatures[feature];
}

/**
 * Check trial status from subscription data.
 */
export function getTrialStatus(sub: {
  trialStartedAt?: { toDate?: () => Date } | null;
  trialTransactionCount?: number;
  trialExpired?: boolean;
}): {
  isOnTrial: boolean;
  trialDaysRemaining: number;
  trialTransactionsRemaining: number;
  trialExpired: boolean;
} {
  if (sub.trialExpired) {
    return { isOnTrial: false, trialDaysRemaining: 0, trialTransactionsRemaining: 0, trialExpired: true };
  }

  if (!sub.trialStartedAt) {
    return { isOnTrial: false, trialDaysRemaining: 0, trialTransactionsRemaining: 0, trialExpired: false };
  }

  const startDate = sub.trialStartedAt.toDate ? sub.trialStartedAt.toDate() : new Date(sub.trialStartedAt as unknown as string);
  const now = new Date();
  const daysSinceStart = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const daysRemaining = Math.max(0, TRIAL_DURATION_DAYS - daysSinceStart);
  const txCount = sub.trialTransactionCount ?? 0;
  const txRemaining = Math.max(0, TRIAL_TRANSACTION_LIMIT - txCount);

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
export function mapLegacyPlan(planId: PlanId): PlanId {
  switch (planId) {
    case "starter": return "data";
    case "business": return "smart";
    default: return planId;
  }
}

/**
 * Create a default subscription doc for a new/free user.
 */
export function createDefaultSubscriptionData(userId: string) {
  const plan = PLANS.free;
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return {
    userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: "none" as const,
    plan: "free" as const,
    billingPeriod: "monthly" as const,
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
