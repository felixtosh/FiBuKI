import { Timestamp } from "firebase/firestore";
import type { Timestamp as AdminTimestamp } from "firebase-admin/firestore";
import { MessagePart } from "./chat";

/**
 * Timestamp type that works with both client and admin SDK
 */
export type FirestoreTimestamp = Timestamp | AdminTimestamp;

/**
 * Supported worker types for automation tasks
 */
export type WorkerType = "file_matching" | "partner_matching" | "file_partner_matching" | "receipt_search" | "partner_file_batch";

/**
 * Status of a worker run
 */
export type WorkerRunStatus =
  | "pending" // Queued but not started
  | "running" // Currently executing
  | "completed" // Finished successfully
  | "failed" // Finished with error
  | "cancelled"; // User cancelled

/**
 * Configuration for a worker type
 */
export interface WorkerConfig {
  type: WorkerType;
  name: string;
  description: string;
  toolNames: string[];
  systemPromptKey: string;
  maxMessages: number;
  /** Max individual tool calls before stopping (prevents runaway workers) */
  maxToolCalls: number;
  timeoutSeconds: number;
}

/**
 * A message within a worker run transcript
 */
export interface WorkerMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts?: MessagePart[];
  createdAt: FirestoreTimestamp;
}

/**
 * An action performed by a worker
 */
export interface WorkerAction {
  action: string;
  targetId: string;
  result: "success" | "skipped" | "error";
  details?: string;
}

/**
 * Trigger context for a worker run
 */
export interface WorkerTriggerContext {
  fileId?: string;
  transactionId?: string;
  batchId?: string;
  /** For partner_file_batch: the partner being batch-processed */
  partnerId?: string;
  /** For partner_file_batch: all file IDs in the batch */
  fileIds?: string[];
  /** Top suggestion confidence at time of queueing */
  topSuggestionConfidence?: number;
  /** Whether this was triggered after rule-based matching */
  triggeredAfterRuleBasedMatch?: boolean;
}

/**
 * A complete worker run with transcript
 */
export interface WorkerRun {
  id: string;
  userId: string;
  workerType: WorkerType;
  status: WorkerRunStatus;

  // Trigger info
  triggeredBy: "auto" | "user";
  triggerContext?: WorkerTriggerContext;

  // Transcript
  messages: WorkerMessage[];

  // Results summary
  summary?: string;
  actionsPerformed?: WorkerAction[];

  // Timing
  createdAt: FirestoreTimestamp;
  startedAt?: FirestoreTimestamp;
  completedAt?: FirestoreTimestamp;

  // Error handling
  error?: string;
  errorCode?: string;
}

/**
 * Input to start a worker run
 */
export interface WorkerRunInput {
  workerType: WorkerType;
  initialPrompt: string;
  triggerContext?: WorkerTriggerContext;
  triggeredBy?: "auto" | "user";
  /** Optional source workerRequest document ID (for queue/state coordination) */
  workerRequestId?: string;
}

/**
 * Output from a completed worker run
 */
export interface WorkerRunOutput {
  runId: string;
  status: WorkerRunStatus;
  messages: WorkerMessage[];
  summary?: string;
  actionsPerformed?: WorkerAction[];
  error?: string;
}
