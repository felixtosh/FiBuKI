import { Timestamp } from "firebase/firestore";

// =============================================================================
// Plan Tiers
// =============================================================================

export type PlanId = "free" | "starter" | "business" | "pro";
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
}

export const PLANS: Record<PlanId, PlanConfig> = {
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
  // Migration
  grandfatheredUntil?: Timestamp | null;
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
