import { Timestamp } from "firebase/firestore";

/**
 * MFA settings for a user
 * Stored at: users/{userId}/mfaSettings/config
 */
export interface MfaSettings {
  userId: string;
  totpEnabled: boolean;
  totpFactorId?: string; // Firebase MFA factor UID
  totpEnrolledAt?: Timestamp;
  passkeysEnabled: boolean;
  backupCodesGenerated: boolean;
  backupCodesGeneratedAt?: Timestamp;
  backupCodesRemaining: number;
  lastMfaMethod?: MfaMethod; // Last successfully used MFA method
  lastMfaMethodAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * WebAuthn passkey credential
 * Stored at: users/{userId}/passkeys/{credentialId}
 */
export interface PasskeyCredential {
  id: string;
  userId: string;
  credentialId: string; // Base64URL encoded credential ID
  publicKey: string; // Base64URL encoded public key
  counter: number; // Signature counter for replay attack prevention
  deviceName: string; // User-provided friendly name
  transports?: AuthenticatorTransport[]; // usb, nfc, ble, internal, hybrid
  aaguid?: string; // Authenticator attestation GUID
  createdAt: Timestamp;
  lastUsedAt?: Timestamp;
}

/**
 * Authenticator transport types (from WebAuthn spec)
 */
export type AuthenticatorTransport =
  | "usb"
  | "nfc"
  | "ble"
  | "internal"
  | "hybrid";

/**
 * MFA backup code (one-time use)
 * Stored at: users/{userId}/backupCodes/{codeId}
 */
export interface MfaBackupCode {
  id: string;
  userId: string;
  codeHash: string; // SHA-256 hash of the backup code
  used: boolean;
  usedAt?: Timestamp;
  createdAt: Timestamp;
}

/**
 * MFA method types
 */
export type MfaMethod = "totp" | "passkey" | "backup_code";

/**
 * MFA audit log entry
 * Stored at: mfaAuditLogs/{logId}
 */
export interface MfaAuditLog {
  id: string;
  userId: string;
  action:
    | "totp_enabled"
    | "totp_disabled"
    | "passkey_registered"
    | "passkey_removed"
    | "backup_codes_generated"
    | "backup_codes_regenerated"
    | "challenge_success"
    | "challenge_failed"
    | "admin_reset";
  method?: MfaMethod;
  ipAddress?: string;
  userAgent?: string;
  performedBy?: string; // For admin actions, the admin's userId
  metadata?: Record<string, unknown>;
  timestamp: Timestamp;
}

/**
 * WebAuthn registration options (client-side)
 */
export interface PasskeyRegistrationOptions {
  challenge: string;
  rp: {
    name: string;
    id: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: Array<{
    type: "public-key";
    alg: number;
  }>;
  timeout: number;
  attestation: "none" | "indirect" | "direct";
  authenticatorSelection: {
    authenticatorAttachment?: "platform" | "cross-platform";
    residentKey: "preferred" | "required" | "discouraged";
    userVerification: "preferred" | "required" | "discouraged";
  };
  excludeCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
}

/**
 * WebAuthn authentication options (client-side)
 */
export interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "preferred" | "required" | "discouraged";
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
}

/**
 * Temporary challenge storage for WebAuthn
 * Stored at: users/{userId}/passkeyChallenge (single doc, short-lived)
 */
export interface PasskeyChallenge {
  challenge: string;
  type: "registration" | "authentication";
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/**
 * MFA status response from getMfaStatus function
 */
export interface MfaStatusResponse {
  totpEnabled: boolean;
  passkeysEnabled: boolean;
  passkeyCount: number;
  passkeys: Array<{
    id: string;
    deviceName: string;
    createdAt: Timestamp;
    lastUsedAt?: Timestamp;
  }>;
  backupCodesRemaining: number;
  hasAnyMfa: boolean;
  lastMfaMethod?: MfaMethod;
}

/**
 * Backup codes generation response
 */
export interface BackupCodesResponse {
  codes: string[]; // Plain text codes, shown only once
  generatedAt: Timestamp;
}
