import { Timestamp } from "firebase/firestore";
import type { CallableName } from "@/functions/src/callableRegistry";

/**
 * Record of a Cloud Function invocation for usage tracking.
 * Stored in the `functionCalls` Firestore collection.
 */
export interface FunctionCallRecord {
  id: string;
  functionName: CloudFunctionName;
  userId: string;
  status: "success" | "error";
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Timestamp;
}

/**
 * Every callable the backend serves, by wire name. The backend's registry is
 * the one list (#648): a callable that is not in it does not compile.
 */
export type CloudFunctionName = CallableName;

/**
 * Summary statistics for function calls (for dashboards).
 */
export interface FunctionCallSummary {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  byFunction: Record<
    string,
    {
      calls: number;
      successCount: number;
      errorCount: number;
      avgDurationMs: number;
    }
  >;
}

/**
 * Daily statistics for function calls.
 */
export interface FunctionCallDailyStats {
  date: string; // ISO date string (YYYY-MM-DD)
  calls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
}
