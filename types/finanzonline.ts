import type { Timestamp } from "firebase/firestore";

/**
 * FinanzOnline WebService integration types
 * For direct UVA submission to Austrian tax authority
 */

/**
 * Public metadata stored in userData (visible to client)
 */
export interface FinanzOnlineConfig {
  /** Whether credentials are configured */
  isConfigured: boolean;

  /** Participant ID (visible for reference) */
  teilnehmerId?: string;

  /** WebService user ID (visible for reference) */
  benutzerId?: string;

  /** Last successful submission timestamp */
  lastSubmissionAt?: Timestamp;

  /** Connection status after last test */
  connectionStatus?: "valid" | "invalid" | "untested";

  /** Last error message if connection failed */
  lastError?: string;
}

/**
 * Encrypted credentials stored server-side only
 * Collection: /finanzonlineCredentials/{userId}
 */
export interface FinanzOnlineCredentialsDocument {
  userId: string;

  /** Participant ID (Teilnehmer-ID) */
  teilnehmerId: string;

  /** WebService user ID (Benutzer-ID) */
  benutzerId: string;

  /** Encrypted PIN (AES-256-GCM) */
  encryptedPin: string;

  /** Initialization vector for decryption */
  iv: string;

  /** When credentials were last updated */
  updatedAt: Timestamp;

  /** When credentials were created */
  createdAt: Timestamp;
}

/**
 * Submission record for audit trail
 * Collection: /finanzonlineSubmissions/{submissionId}
 */
export interface FinanzOnlineSubmission {
  id: string;
  userId: string;

  /** Period details */
  periodYear: number;
  periodNumber: number;
  periodType: "monthly" | "quarterly";

  /** Submission timestamps */
  submittedAt: Timestamp;

  /** Reference number from BMF (Abgabevermerk) */
  referenceNumber?: string;

  /** Submission status */
  status: "pending" | "success" | "failed";

  /** Error message if failed */
  errorMessage?: string;

  /** SHA256 hash of submitted XML for audit */
  xmlHash: string;

  /** Tax number used for submission */
  taxNumber: string;
}

/**
 * Request to save FinanzOnline credentials
 */
export interface SaveCredentialsRequest {
  teilnehmerId: string;
  benutzerId: string;
  pin: string;
}

/**
 * Response from save credentials
 */
export interface SaveCredentialsResponse {
  success: boolean;
}

/**
 * Response from test connection
 */
export interface TestConnectionResponse {
  success: boolean;
  error?: string;
}

/**
 * Request to submit UVA
 */
export interface SubmitUvaRequest {
  report: {
    taxableRevenue: {
      rate20Net: number;
      rate20Vat: number;
      rate10Net: number;
      rate10Vat: number;
      rate13Net: number;
      rate13Vat: number;
    };
    exemptRevenue: {
      exports: number;
      euDeliveries: number;
      other: number;
    };
    euAcquisitions: {
      netAmount: number;
      vatAmount: number;
    };
    inputVat: {
      standard: number;
      euAcquisitions: number;
      imports: number;
    };
    totalVatPayable: number;
    totalInputVat: number;
    vatBalance: number;
  };
  period: {
    year: number;
    period: number;
    type: "monthly" | "quarterly";
  };
  taxNumber: string;
}

/**
 * Response from UVA submission
 */
export interface SubmitUvaResponse {
  success: boolean;
  referenceNumber?: string;
  submissionId?: string;
  error?: string;
}

/**
 * SOAP session login result
 */
export interface SessionLoginResult {
  sessionId: string;
  returnCode: string;
  message?: string;
}

/**
 * SOAP file upload result
 */
export interface FileUploadResult {
  returnCode: string;
  message: string;
  referenceNumber?: string;
}
