/**
 * FinanzOnline WebService types for Cloud Functions
 */

import { Timestamp } from "firebase-admin/firestore";

/**
 * Encrypted credentials stored server-side only
 * Collection: /finanzonlineCredentials/{userId}
 */
export interface FinanzOnlineCredentialsDocument {
  userId: string;
  teilnehmerId: string;
  benutzerId: string;
  encryptedPin: string;
  iv: string;
  updatedAt: Timestamp;
  createdAt: Timestamp;
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
 * UVA figures for submission: Kennzahl code → value in cents, as produced
 * by the calculation module (functions/src/uva). Replaces the legacy
 * UVAReportData shape whose hand-mapping had 12 of 16 KZ codes wrong.
 */
export type UvaKennzahlValues = Record<string, number>;

/**
 * Report period
 */
export interface ReportPeriod {
  year: number;
  period: number;
  type: "monthly" | "quarterly";
}

/**
 * Request to submit UVA
 */
export interface SubmitUvaRequest {
  kennzahlen: UvaKennzahlValues;
  period: ReportPeriod;
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
 * Submission record for audit trail
 * Collection: /finanzonlineSubmissions/{submissionId}
 */
export interface FinanzOnlineSubmission {
  id: string;
  userId: string;
  periodYear: number;
  periodNumber: number;
  periodType: "monthly" | "quarterly";
  submittedAt: Timestamp;
  referenceNumber?: string;
  status: "pending" | "success" | "failed";
  errorMessage?: string;
  xmlHash: string;
  taxNumber: string;
}
