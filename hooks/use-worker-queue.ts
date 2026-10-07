/**
 * Worker Queue Processor Hook
 *
 * Listens to the workerRequests collection and processes pending requests
 * concurrently (up to MAX_CONCURRENT). Workers for the same partner never
 * run simultaneously. Partner batch dedupe/reruns are managed by
 * users/{userId}/partnerBatchStates.
 *
 * Scheduling logic is delegated to WorkerQueueScheduler (pure TS, testable).
 * This hook wires the scheduler to React state + Firestore.
 */

import { useState, useEffect, useRef } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  Timestamp,
  runTransaction,
  deleteField,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { WorkerType } from "@/types/worker";
import { WorkerQueueScheduler } from "../functions/src/worker/worker-queue-scheduler";

/**
 * Get ID token from the current user
 */
async function getIdToken(user: { getIdToken: () => Promise<string> } | null): Promise<string | null> {
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

interface WorkerRequest {
  id: string;
  workerType: WorkerType;
  initialPrompt: string;
  triggerContext?: {
    fileId?: string;
    transactionId?: string;
    partnerId?: string;
    fileIds?: string[];
    topSuggestionConfidence?: number;
    triggeredAfterRuleBasedMatch?: boolean;
  };
  triggeredBy: "auto" | "user";
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  createdAt: Timestamp;
  notBeforeAt?: Timestamp;
  error?: string;
}

const MAX_CONCURRENT = 3;
const DISPATCH_INTERVAL_MS = 15_000;
const REAUTH_RETRY_DELAY_MS = 10 * 60 * 1000;

function isGmailReauthErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("auth_expired") ||
    lower.includes("token_expired") ||
    lower.includes("reauth_required") ||
    lower.includes("re-authentication required") ||
    lower.includes("reconnect gmail") ||
    lower.includes("tokens_missing") ||
    lower.includes("needs reconnection") ||
    lower.includes("needs reauth")
  );
}

function buildReauthPauseMessage(errorMessage?: string): string {
  return errorMessage?.trim() ||
    "Paused: a mailbox needs reconnection. This worker will resume automatically after reconnect.";
}

interface UseWorkerQueueOptions {
  /** Enable queue processing (default: true) */
  enabled?: boolean;
}

export function useWorkerQueue(options: UseWorkerQueueOptions = {}) {
  const { enabled = true } = options;
  const { user } = useAuth();

  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Keep a ref to user so callbacks can read the latest value
  const userRef = useRef(user);
  userRef.current = user;

  // Stable ref for processRequest so onDispatch closure doesn't go stale
  const processRequestRef = useRef<((req: WorkerRequest) => Promise<void>) | null>(null);

  // Initialise scheduler once (persists across renders)
  const schedulerRef = useRef<WorkerQueueScheduler<WorkerRequest> | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = new WorkerQueueScheduler<WorkerRequest>(MAX_CONCURRENT, {
      onDispatch: (req) => processRequestRef.current!(req),
      onCancel: (req) => {
        const uid = userRef.current?.uid;
        if (!uid) return;
        updateDoc(doc(db, `users/${uid}/workerRequests`, req.id), {
          status: "cancelled",
          cancelReason: "partner_batch_completed",
          completedAt: Timestamp.now(),
        }).catch(console.error);
      },
      onStateChange: ({ pendingCount: p, isProcessing: ip }) => {
        setPendingCount(p);
        setIsProcessing(ip);
      },
    });
  }

  // Process a single worker request (Firestore claim + /api/worker call)
  processRequestRef.current = async (request: WorkerRequest): Promise<void> => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    const idToken = await getIdToken(currentUser);
    if (!idToken) {
      console.error("[WorkerQueue] Failed to get ID token");
      return;
    }

    const requestRef = doc(db, `users/${currentUser.uid}/workerRequests`, request.id);

    try {
      // Atomically claim the request - prevents race conditions with multiple tabs
      const claimed = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(requestRef);
        if (!docSnap.exists()) return false;

        const data = docSnap.data();
        if (data.status !== "pending") {
          // Already claimed by another tab
          return false;
        }

        transaction.update(requestRef, {
          status: "processing",
          startedAt: Timestamp.now(),
        });
        return true;
      });

      if (!claimed) {
        console.log(`[WorkerQueue] Request ${request.id} already claimed by another tab`);
        return;
      }

      console.log(`[WorkerQueue] Processing request ${request.id}: ${request.workerType}`);

      // Call the worker API
      const response = await fetch("/api/worker", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          workerType: request.workerType,
          initialPrompt: request.initialPrompt,
          triggerContext: request.triggerContext,
          workerRequestId: request.id,
          triggeredBy: request.triggeredBy,
          modelProvider: "gemini", // Use cheaper model for automated tasks
        }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const apiError = result?.error || "Worker API request failed";
        const err = new Error(apiError) as Error & { code?: string };
        if (typeof result?.errorCode === "string") {
          err.code = result.errorCode;
        } else if (typeof result?.code === "string") {
          err.code = result.code;
        }
        throw err;
      }

      if (result?.status === "blocked_for_reauth") {
        const retryAfterMs =
          typeof result.retryAfterMs === "number" && result.retryAfterMs > 0
            ? result.retryAfterMs
            : REAUTH_RETRY_DELAY_MS;
        const pauseMessage = buildReauthPauseMessage(result.error);

        await updateDoc(requestRef, {
          status: "pending",
          startedAt: null,
          completedAt: deleteField(),
          error: deleteField(),
          lastError: pauseMessage,
          pauseReason: "reauth_required",
          notBeforeAt: Timestamp.fromMillis(Date.now() + retryAfterMs),
          updatedAt: Timestamp.now(),
          ...(result.runId ? { workerRunId: result.runId } : {}),
        });
        console.log(`[WorkerQueue] Requeued request ${request.id} (blocked_for_reauth)`);
        return;
      }

      if (result?.status === "failed") {
        const apiError = result.error || "Worker execution failed";
        const err = new Error(apiError) as Error & { code?: string };
        if (typeof result?.errorCode === "string") {
          err.code = result.errorCode;
        }
        throw err;
      }

      // Mark as completed (only include summary if defined)
      await updateDoc(requestRef, {
        status: "completed",
        completedAt: Timestamp.now(),
        error: deleteField(),
        lastError: deleteField(),
        pauseReason: deleteField(),
        notBeforeAt: deleteField(),
        workerRunId: result.runId,
        ...(result.summary !== undefined && { summary: result.summary }),
      });

      // Update transaction automation history if this was a receipt search
      if (request.workerType === "receipt_search" && request.triggerContext?.transactionId) {
        await updateTransactionAutomationHistory(
          request.triggerContext.transactionId,
          request.id,
          "completed",
          result.summary
        );
      }

      console.log(`[WorkerQueue] Completed request ${request.id}:`, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorCode =
        error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      const isReauthError =
        (errorCode && isGmailReauthErrorMessage(errorCode)) ||
        isGmailReauthErrorMessage(errorMessage);

      if (isReauthError) {
        await updateDoc(requestRef, {
          status: "pending",
          startedAt: null,
          completedAt: deleteField(),
          error: deleteField(),
          lastError: buildReauthPauseMessage(errorMessage),
          pauseReason: "reauth_required",
          notBeforeAt: Timestamp.fromMillis(Date.now() + REAUTH_RETRY_DELAY_MS),
          updatedAt: Timestamp.now(),
        });
        console.warn(`[WorkerQueue] Requeued request ${request.id} due to Gmail reauth requirement`);
        return;
      }

      // Mark as failed
      await updateDoc(requestRef, {
        status: "failed",
        completedAt: Timestamp.now(),
        pauseReason: deleteField(),
        notBeforeAt: deleteField(),
        error: errorMessage,
      });

      // Update transaction automation history if this was a receipt search
      if (request.workerType === "receipt_search" && request.triggerContext?.transactionId) {
        await updateTransactionAutomationHistory(
          request.triggerContext.transactionId,
          request.id,
          "failed",
          errorMessage
        );
      }

      console.error(`[WorkerQueue] Failed request ${request.id}:`, error);
    }
  };

  // Update transaction automation history after worker completes
  const updateTransactionAutomationHistory = async (
    transactionId: string,
    workerRequestId: string,
    status: "completed" | "failed" | "no_match",
    summary?: string
  ) => {
    try {
      console.log(`[WorkerQueue] Would update automation history for ${transactionId}:`, {
        workerRequestId,
        status,
        summary,
      });
    } catch (error) {
      console.error(`[WorkerQueue] Failed to update automation history:`, error);
    }
  };

  // Listen to pending worker requests
  useEffect(() => {
    if (!user?.uid || !enabled) return;

    const q = query(
      collection(db, `users/${user.uid}/workerRequests`),
      where("status", "==", "pending"),
      orderBy("createdAt", "asc"),
      limit(100)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const requests = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as WorkerRequest[];

      const scheduler = schedulerRef.current!;
      scheduler.enqueue(requests);
      scheduler.dispatch();
    });

    return () => unsubscribe();
  }, [user?.uid, enabled]);

  // Future-dated requests may become eligible without a new snapshot event.
  // Poll dispatch periodically so scheduler can pick newly due requests.
  useEffect(() => {
    if (!enabled || !user?.uid) return;

    const intervalId = setInterval(() => {
      schedulerRef.current?.dispatch();
    }, DISPATCH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [enabled, user?.uid]);

  return {
    isProcessing,
    pendingCount,
  };
}
