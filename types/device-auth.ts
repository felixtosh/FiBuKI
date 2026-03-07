/**
 * Device Authorization Flow Types
 *
 * Used by:
 * - CLI (npx @fibukiapp/cli auth)
 * - API routes (app/api/auth/device/*)
 * - Approval page (app/auth/device/page.tsx)
 */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  key_name?: string;
  error?: "authorization_pending" | "slow_down" | "expired_token" | "invalid_grant";
  error_description?: string;
}

export interface DeviceCodeDoc {
  deviceCode: string;
  userCode: string;
  status: "pending" | "approved" | "expired";
  apiKey?: string;
  apiKeyName?: string;
  userId?: string;
  ipAddress?: string;
  lastPolledAt?: FirebaseFirestore.Timestamp;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
}
