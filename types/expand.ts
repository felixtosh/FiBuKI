import { Timestamp } from "firebase/firestore";

// =============================================================================
// Country Expansion (Firestore: countryExpansion/{countryCode})
// =============================================================================

export type CountryExpansionStatus = "funding" | "active" | "coming_soon";

export interface CountryExpansion {
  countryCode: string;
  countryName: string;
  status: CountryExpansionStatus;
  targetBackers: number;
  currentBackers: number;
  totalCommitted: number; // cents
  monthlyCost: number; // cents (e.g. 20000 = €200)
  activatedAt?: Timestamp;
  createdAt: Timestamp;
}

// =============================================================================
// Country Backer (Firestore: countryBackers/{id})
// =============================================================================

export type CountryBackerStatus = "paid" | "refunded" | "converted";

export interface CountryBacker {
  countryCode: string;
  email: string;
  userId?: string;
  stripePaymentIntentId: string;
  amount: number; // cents (e.g. 1000 = €10)
  status: CountryBackerStatus;
  convertedToSubscriptionId?: string;
  createdAt: Timestamp;
}

// =============================================================================
// Callable Request/Response Types
// =============================================================================

export interface BackCountryRequest {
  countryCode: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BackCountryResponse {
  checkoutUrl: string;
}

export interface ActivateCountryRequest {
  countryCode: string;
}

export interface ActivateCountryResponse {
  success: boolean;
  backerCount: number;
}

export interface RefundCountryBackersRequest {
  countryCode: string;
}

export interface RefundCountryBackersResponse {
  success: boolean;
  refundedCount: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default backing amount in cents (€10) */
export const BACKING_AMOUNT_CENTS = 1000;

/** Default target backers before country activation */
export const DEFAULT_TARGET_BACKERS = 30;

/** Monthly finAPI cost per country in cents (€200) */
export const MONTHLY_COST_CENTS = 20000;

// =============================================================================
// Country Data (static, for seeding + UI)
// =============================================================================

export interface ExpandableCountry {
  code: string;
  name: string;
  flag: string;
}

/** PSD2 countries available for expansion (excluding Austria which is live) */
export const EXPANDABLE_COUNTRIES: ExpandableCountry[] = [
  { code: "DE", name: "Germany", flag: "🇩🇪" },
  { code: "FR", name: "France", flag: "🇫🇷" },
  { code: "IT", name: "Italy", flag: "🇮🇹" },
  { code: "ES", name: "Spain", flag: "🇪🇸" },
  { code: "NL", name: "Netherlands", flag: "🇳🇱" },
  { code: "BE", name: "Belgium", flag: "🇧🇪" },
  { code: "PT", name: "Portugal", flag: "🇵🇹" },
  { code: "IE", name: "Ireland", flag: "🇮🇪" },
  { code: "FI", name: "Finland", flag: "🇫🇮" },
  { code: "LU", name: "Luxembourg", flag: "🇱🇺" },
  { code: "GR", name: "Greece", flag: "🇬🇷" },
  { code: "SK", name: "Slovakia", flag: "🇸🇰" },
  { code: "SI", name: "Slovenia", flag: "🇸🇮" },
];
