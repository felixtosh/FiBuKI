"use client";

import { httpsCallable, HttpsCallableResult } from "firebase/functions";
import { functions } from "./config";
import { CloudFunctionName } from "@/types/function-call";

/**
 * Type-safe wrapper for calling Cloud Functions.
 * Automatically handles the request/response pattern and extracts data.
 *
 * @example
 * ```typescript
 * const result = await callFunction<UpdateRequest, UpdateResponse>(
 *   "updateTransaction",
 *   { id: "abc", data: { amount: 100 } }
 * );
 * ```
 */
export async function callFunction<TRequest, TResponse>(
  name: CloudFunctionName,
  data: TRequest
): Promise<TResponse> {
  const fn = httpsCallable<TRequest, TResponse>(functions, name);
  const result: HttpsCallableResult<TResponse> = await fn(data);
  return result.data;
}

/**
 * Call a Cloud Function and return the raw result (includes metadata).
 * Use this when you need access to the full HttpsCallableResult.
 */
export async function callFunctionRaw<TRequest, TResponse>(
  name: CloudFunctionName,
  data: TRequest
): Promise<HttpsCallableResult<TResponse>> {
  const fn = httpsCallable<TRequest, TResponse>(functions, name);
  return fn(data);
}

/**
 * Create a typed callable function reference for repeated use.
 * Useful when you need to call the same function multiple times.
 *
 * @example
 * ```typescript
 * const updateTransaction = createCallable<UpdateRequest, UpdateResponse>("updateTransaction");
 * await updateTransaction({ id: "abc", data: { amount: 100 } });
 * ```
 */
export function createCallable<TRequest, TResponse>(name: CloudFunctionName) {
  const fn = httpsCallable<TRequest, TResponse>(functions, name);
  return async (data: TRequest): Promise<TResponse> => {
    const result = await fn(data);
    return result.data;
  };
}

// ============================================================================
// Pre-typed function callers for common operations
// These provide full type safety without needing to specify generics
// ============================================================================

// Transaction operations
export interface UpdateTransactionRequest {
  id: string;
  data: Record<string, unknown>;
}

export interface UpdateTransactionResponse {
  success: boolean;
}

export const updateTransactionCallable = createCallable<
  UpdateTransactionRequest,
  UpdateTransactionResponse
>("updateTransaction");

// File operations
export interface ConnectFileRequest {
  fileId: string;
  transactionId: string;
}

export interface ConnectFileResponse {
  success: boolean;
}

export const connectFileToTransactionCallable = createCallable<
  ConnectFileRequest,
  ConnectFileResponse
>("connectFileToTransaction");

export const disconnectFileFromTransactionCallable = createCallable<
  ConnectFileRequest,
  { success: boolean }
>("disconnectFileFromTransaction");

// Bulk operations
export interface BulkCreateTransactionsRequest {
  transactions: Array<Record<string, unknown>>;
  sourceId: string;
}

export interface BulkCreateTransactionsResponse {
  success: boolean;
  transactionIds: string[];
  count: number;
}

export const bulkCreateTransactionsCallable = createCallable<
  BulkCreateTransactionsRequest,
  BulkCreateTransactionsResponse
>("bulkCreateTransactions");

// Import record operations
export interface CreateImportRecordRequest {
  sourceId: string;
  sourceName: string;
  totalTransactions: number;
  newTransactions: number;
  skippedDuplicates: number;
  rawFileName?: string;
  rawFileSize?: number;
  fieldMappings?: Record<string, string>;
}

export interface CreateImportRecordResponse {
  success: boolean;
  importId: string;
}

export const createImportRecordCallable = createCallable<
  CreateImportRecordRequest,
  CreateImportRecordResponse
>("createImportRecord");

// Billing operations
import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  AddAICreditsRequest,
  AddAICreditsResponse,
  UpdateOverageSettingsRequest,
  UpdateOverageSettingsResponse,
} from "@/types/billing";

export const createCheckoutSessionCallable = createCallable<
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse
>("createCheckoutSession");

export const createPortalSessionCallable = createCallable<
  CreatePortalSessionRequest,
  CreatePortalSessionResponse
>("createPortalSession");

export const addAICreditsCallable = createCallable<
  AddAICreditsRequest,
  AddAICreditsResponse
>("addAICredits");

export const updateOverageSettingsCallable = createCallable<
  UpdateOverageSettingsRequest,
  UpdateOverageSettingsResponse
>("updateOverageSettings");
