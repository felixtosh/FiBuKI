/**
 * Factory for creating Cloud Functions with automatic usage tracking.
 * All data operations should use this wrapper to ensure consistent
 * logging of function invocations for admin and user dashboards.
 */

import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { SecretParam } from "firebase-functions/params";
import { estimateModelCost } from "./models";
import type { CallableName } from "../callableRegistry";

// Re-export HttpsError for convenience
export { HttpsError };

export interface CallableConfig {
  /**
   * The callable's wire name: its barrel export, and the key of its usage log
   * and AI usage records. Registered in `callableRegistry.ts`, or this does not
   * compile.
   */
  name: CallableName;
  /** Memory allocation (default: 256MiB) */
  memory?: "256MiB" | "512MiB" | "1GiB" | "2GiB";
  /** Timeout in seconds (default: 60) */
  timeoutSeconds?: number;
  /** Secrets required by this function */
  secrets?: SecretParam[];
  /** Skip usage logging (for internal/utility functions) */
  skipUsageLogging?: boolean;
  /** Allow unauthenticated access (for public endpoints like listing banks) */
  allowUnauthenticated?: boolean;
}

export interface FunctionCallLog {
  functionName: string;
  userId: string;
  status: "success" | "error";
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: FieldValue;
}

export interface HandlerContext {
  /** Authenticated user ID */
  userId: string;
  /** Firestore instance */
  db: FirebaseFirestore.Firestore;
  /** Original request for advanced use cases */
  request: CallableRequest;
  /** Log additional AI usage for this call */
  logAIUsage: (params: AIUsageParams) => Promise<void>;
}

export interface AIUsageParams {
  model: string;
  inputTokens: number;
  outputTokens: number;
  function?:
    | "chat"
    | "companyLookup"
    | "companyLookupSearch"
    | "patternLearning"
    | "columnMatching"
    | "extraction"
    | "classification"
    | "domainValidation";
  metadata?: {
    partnerId?: string;
    sourceId?: string;
    fileId?: string;
    webSearchUsed?: boolean;
  } | null;
}

function calculateAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  return estimateModelCost(model, inputTokens, outputTokens);
}

/**
 * Create a callable Cloud Function with automatic usage tracking.
 *
 * @example
 * ```typescript
 * export const updateTransactionCallable = createCallable<UpdateRequest, UpdateResponse>(
 *   { name: "updateTransaction" },
 *   async (ctx, data) => {
 *     // ctx.userId - authenticated user
 *     // ctx.db - Firestore instance
 *     // ctx.logAIUsage() - log AI usage if needed
 *     return { success: true };
 *   }
 * );
 * ```
 */
// CORS origins for callable functions
const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

/**
 * The `config.name` each callable was created with. The name is not readable
 * off the function Firebase returns, and the registry test needs it to check
 * that a callable's wire name (its barrel export) is its `config.name`.
 */
const configNames = new WeakMap<object, string>();

export function callableConfigName(fn: unknown): string | undefined {
  return typeof fn === "function" ? configNames.get(fn) : undefined;
}

export function createCallable<TRequest, TResponse>(
  config: CallableConfig,
  handler: (ctx: HandlerContext, data: TRequest) => Promise<TResponse>
) {
  const callable = onCall<TRequest, Promise<TResponse>>(
    {
      region: "europe-west1",
      memory: config.memory || "256MiB",
      timeoutSeconds: config.timeoutSeconds || 60,
      secrets: config.secrets || [],
      cors: CORS_ORIGINS,
    },
    async (request) => {
      // 1. Auth check (skip if allowUnauthenticated)
      if (!config.allowUnauthenticated && !request.auth) {
        throw new HttpsError("unauthenticated", "Must be authenticated");
      }

      const userId = request.auth?.uid || "anonymous";
      const startTime = Date.now();
      const db = getFirestore();

      // AI usage accumulator for this call
      const aiUsageRecords: AIUsageParams[] = [];

      // Create context for handler
      const ctx: HandlerContext = {
        userId,
        db,
        request,
        logAIUsage: async (params: AIUsageParams) => {
          aiUsageRecords.push(params);
        },
      };

      console.log(`[${config.name}] Started`, { userId });

      try {
        // 2. Execute handler
        const result = await handler(ctx, request.data);
        const durationMs = Date.now() - startTime;

        console.log(`[${config.name}] Success`, { userId, durationMs });

        // 3. Log success (non-blocking)
        if (!config.skipUsageLogging) {
          logFunctionCall(db, {
            functionName: config.name,
            userId,
            status: "success",
            durationMs,
            createdAt: FieldValue.serverTimestamp(),
          }).catch((err) =>
            console.error(`[${config.name}] Failed to log success:`, err)
          );
        }

        // 4. Log any AI usage (non-blocking)
        for (const aiUsage of aiUsageRecords) {
          logAIUsageRecord(db, userId, aiUsage, config.name).catch((err) =>
            console.error(`[${config.name}] Failed to log AI usage:`, err)
          );
        }

        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorCode =
          error instanceof HttpsError ? error.code : "internal";
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        console.error(`[${config.name}] Error`, {
          userId,
          durationMs,
          errorCode,
          errorMessage,
        });

        // Log error (non-blocking)
        if (!config.skipUsageLogging) {
          logFunctionCall(db, {
            functionName: config.name,
            userId,
            status: "error",
            durationMs,
            errorCode,
            errorMessage,
            createdAt: FieldValue.serverTimestamp(),
          }).catch((err) =>
            console.error(`[${config.name}] Failed to log error:`, err)
          );
        }

        // Re-throw HttpsError as-is, wrap others
        if (error instanceof HttpsError) {
          throw error;
        }
        throw new HttpsError("internal", "Operation failed");
      }
    }
  );
  configNames.set(callable, config.name);
  return callable;
}

async function logFunctionCall(
  db: FirebaseFirestore.Firestore,
  log: FunctionCallLog
): Promise<void> {
  await db.collection("functionCalls").add(log);
}

async function logAIUsageRecord(
  db: FirebaseFirestore.Firestore,
  userId: string,
  params: AIUsageParams,
  callingFunction: string
): Promise<void> {
  const cost = calculateAICost(params.model, params.inputTokens, params.outputTokens);

  await db.collection("aiUsage").add({
    userId,
    function: params.function || callingFunction,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    estimatedCost: cost,
    createdAt: FieldValue.serverTimestamp(),
    metadata: params.metadata || null,
  });

  console.log(`[AI Usage] ${params.function || callingFunction}`, {
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    estimatedCost: `$${cost.toFixed(4)}`,
  });
}
