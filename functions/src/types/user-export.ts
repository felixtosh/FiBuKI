import { Timestamp } from "firebase-admin/firestore";

/**
 * Status of a user data export job
 */
export type UserExportStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/**
 * Status of a user data import job
 */
export type UserImportStatus =
  | "pending"
  | "validating"
  | "wiping"
  | "importing"
  | "completed"
  | "failed";

/**
 * Export processing phases
 */
export type UserExportPhase =
  | "collecting"
  | "packaging"
  | "uploading"
  | "complete";

/**
 * Import processing phases
 */
export type UserImportPhase =
  | "validating"
  | "wiping"
  | "importing"
  | "complete";

/**
 * Request to initiate a user data export
 */
export interface UserExportRequest {
  includeStorageFiles: boolean;
}

/**
 * Response from requesting an export
 */
export interface UserExportResponse {
  success: boolean;
  exportId: string;
}

/**
 * Progress tracking for export/import jobs
 */
export interface ExportProgress {
  phase: UserExportPhase;
  current: number;
  total: number;
  currentEntity?: string;
}

export interface ImportProgress {
  phase: UserImportPhase;
  current: number;
  total: number;
  currentEntity?: string;
}

/**
 * Counts of exported entities
 */
export interface ExportCounts {
  sources: number;
  transactions: number;
  files: number;
  partners: number;
  categories: number;
  noReceiptCategories: number;
  fileConnections: number;
  storageFiles?: number;
  storageSize?: number;
}

/**
 * A user data export job record
 * Stored in the `userExports` collection
 */
export interface UserExport {
  id: string;
  userId: string;
  status: UserExportStatus;
  includeStorageFiles: boolean;

  // Progress tracking
  progress: ExportProgress;

  // Entity counts
  counts: ExportCounts;

  // Result (when completed)
  downloadUrl?: string;
  storagePath?: string;
  zipSize?: number;
  expiresAt?: Timestamp;

  // Error handling
  error?: string;
  retryCount: number;
  maxRetries: number;

  // Timestamps
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

/**
 * Validation results from analyzing an uploaded ZIP
 */
export interface ImportValidation {
  valid: boolean;
  version: string;
  exportDate?: string;
  counts: Record<string, number>;
  errors: string[];
  warnings: string[];
}

/**
 * Request to validate an uploaded ZIP
 */
export interface ValidateUserImportRequest {
  uploadPath: string;
}

/**
 * Request to execute import (after validation)
 */
export interface ExecuteUserImportRequest {
  importId: string;
  confirmWipe: boolean;
}

/**
 * Response from execute import
 */
export interface ExecuteUserImportResponse {
  success: boolean;
  error?: string;
}

/**
 * A user data import job record
 * Stored in the `userImports` collection
 */
export interface UserImport {
  id: string;
  userId: string;
  status: UserImportStatus;

  // Uploaded ZIP info
  uploadedZipPath: string;
  uploadedZipSize: number;

  // Validation results
  validation?: ImportValidation;

  // Progress tracking
  progress: ImportProgress;

  // Import results
  importedCounts?: Record<string, number>;

  // Error handling
  error?: string;

  // Timestamps
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

/**
 * Manifest file structure inside the export ZIP
 */
export interface ExportManifest {
  version: string;
  exportDate: string;
  userId: string;
  exportId: string;
  includesStorageFiles: boolean;
  counts: ExportCounts;
  storageFiles?: {
    totalSize: number;
    fileCount: number;
  };
}

/**
 * Export expiration period in days
 */
export const EXPORT_EXPIRY_DAYS = 7;

/**
 * Current export format version
 */
export const EXPORT_FORMAT_VERSION = "1.0";
