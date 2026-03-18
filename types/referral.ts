import { Timestamp } from "firebase/firestore";

// =============================================================================
// Referral Code (Firestore: referrals/{referralCode})
// =============================================================================

export interface Referral {
  code: string;
  userId: string;
  createdAt: Timestamp;
}

// =============================================================================
// Referral Conversion (Firestore: referralConversions/{id})
// =============================================================================

export type ReferralConversionStatus = "pending" | "converted" | "expired";

export interface ReferralConversion {
  referralCode: string;
  referrerUserId: string;
  referredUserId: string;
  referredEmail: string;
  status: ReferralConversionStatus;
  referrerCreditApplied: boolean;
  stripePromotionCodeId?: string;
  createdAt: Timestamp;
  convertedAt?: Timestamp;
}

// =============================================================================
// Callable Request/Response Types
// =============================================================================

export interface GetReferralCodeResponse {
  code: string;
  shareUrl: string;
}

export interface ApplyReferralCodeRequest {
  code: string;
}

export interface ApplyReferralCodeResponse {
  valid: boolean;
  referrerName?: string;
}

export interface GetReferralStatsResponse {
  totalReferred: number;
  converted: number;
  pendingCredits: number;
  totalCreditsEur: number;
}
