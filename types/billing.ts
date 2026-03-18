import { Timestamp } from "firebase/firestore";

// =============================================================================
// Plan Tiers
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

// =============================================================================
// Central PLANS Config
// =============================================================================

// =============================================================================
// Plan Features (feature-gating flags)
// =============================================================================

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
  /** Monthly price in EUR (yearly = monthlyPrice * 10) */
  monthlyPriceEur: number;
  /** Max transactions per calendar month */
  transactionLimit: number;
  /** AI fair-use budget per billing period in EUR */
  aiFairUseLimitEur: number;
  /** Whether overage spending is available */
  overageAllowed: boolean;
  /** Feature highlights for plan comparison */
  features: string[];
  /** Gated feature flags */
  planFeatures: PlanFeatures;
  /** API rate limits */
  rateLimit: RateLimitConfig;
}

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
  // Internal-only: expired trial / unsubscribed state
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
  // New tiers
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
  // Legacy tiers (migration only — map to new tiers for feature checks)
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
    planFeatures: NO_AI_FEATURES, // Maps to data, AI via grandfathering
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
    planFeatures: SMART_FEATURES, // Maps to smart
    rateLimit: { perMinute: 120, perHour: 5000 },
  },
};

// =============================================================================
// AI Billing Rate (EUR per 100k total tokens)
// =============================================================================

/** User-facing billing rate: EUR per 100,000 total tokens */
export const USER_TOKEN_RATE_PER_100K_EUR = 0.35;

// =============================================================================
// Subscription Document (Firestore: subscriptions/{userId})
// =============================================================================

export interface Subscription {
  userId: string;
  // Stripe
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: StripeSubscriptionStatus;
  // Plan
  plan: PlanId;
  billingPeriod: BillingPeriod;
  currentPeriodStart: Timestamp;
  currentPeriodEnd: Timestamp;
  cancelAtPeriodEnd: boolean;
  // AI Budget (current billing period)
  aiFairUseLimitEur: number;
  aiUsageCurrentPeriodEur: number;
  aiCreditsEur: number;
  aiOverageCapEur: number;
  aiOverageCurrentPeriodEur: number;
  aiPaused: boolean;
  // Warning flags (reset each period)
  aiWarning90Sent: boolean;
  aiWarning100Sent: boolean;
  // Transaction count (calendar month)
  transactionCountCurrentMonth: number;
  transactionCountMonth: string; // "YYYY-MM"
  // Addons
  addons?: {
    investments?: {
      active: boolean;
      stripeSubscriptionItemId?: string;
      activatedAt?: Timestamp;
    };
  };
  // Trial
  trialTier?: PlanId | null;
  trialStartedAt?: Timestamp | null;
  trialTransactionCount?: number;
  trialExpired?: boolean;
  // Migration
  grandfatheredUntil?: Timestamp | null;
  // Automation mode
  automationMode?: "active" | "passive";
  // Referral
  referredBy?: string;
  // Email preferences
  digestEnabled?: boolean;
  // Admin overrides
  adminOverride?: "free_plan" | "plan_tester" | null;
  adminOverrideSetBy?: string | null;
  adminOverrideSetAt?: Timestamp | null;
  // Timestamps
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// =============================================================================
// Budget Check Result
// =============================================================================

export interface AIBudgetCheckResult {
  allowed: boolean;
  /** Where the cost will be charged */
  source: "fair_use" | "credits" | "overage" | "none";
  /** Remaining EUR in current source */
  remainingEur: number;
  /** Whether AI features are paused */
  paused: boolean;
}

// =============================================================================
// Transaction Quota Check Result
// =============================================================================

export interface TransactionQuotaResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remainingSlots: number;
}

// =============================================================================
// Callable Request/Response Types
// =============================================================================

export interface CreateCheckoutSessionRequest {
  plan: PlanId;
  billingPeriod: BillingPeriod;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutSessionResponse {
  checkoutUrl: string;
}

export interface CreatePortalSessionRequest {
  returnUrl: string;
}

export interface CreatePortalSessionResponse {
  portalUrl: string;
}

export interface AddAICreditsRequest {
  amountEur: number;
  successUrl: string;
  cancelUrl: string;
}

export interface AddAICreditsResponse {
  checkoutUrl: string;
}

export interface UpdateOverageSettingsRequest {
  overageCapEur: number;
}

export interface UpdateOverageSettingsResponse {
  success: boolean;
  aiPaused: boolean;
}

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
 * For legacy plans with grandfathering, checks the grandfatheredUntil date.
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
 * Map legacy plan IDs to their new equivalents.
 */
export function mapLegacyPlan(planId: PlanId): PlanId {
  switch (planId) {
    case "starter": return "data";
    case "business": return "smart";
    default: return planId;
  }
}
