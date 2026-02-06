/**
 * Worker Queue Processor Hook
 *
 * Listens to the workerRequests collection and processes pending requests
 * concurrently (up to MAX_CONCURRENT). Workers for the same partner never
 * run simultaneously. When a partner_file_batch completes, remaining
 * pending requests for that partner are cancelled.
 *
 * Scheduling logic is delegated to WorkerQueueScheduler (pure TS, testable).
 * This hook wires the scheduler to React state + Firestore.
 */

import { useState, useEffect, useRef } from "react";
import { collection, query, where, orderBy, limit, onSnapshot, doc, updateDoc, Timestamp, runTransaction } from "firebase/firestore";
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
  };
  triggeredBy: "auto" | "user";
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Timestamp;
  error?: string;
}

const MAX_CONCURRENT = 3;

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
          triggeredBy: request.triggeredBy,
          modelProvider: "gemini", // Use cheaper model for automated tasks
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Worker API request failed");
      }

      // Mark as completed (only include summary if defined)
      await updateDoc(requestRef, {
        status: "completed",
        completedAt: Timestamp.now(),
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

      // Mark as failed
      await updateDoc(requestRef, {
        status: "failed",
        completedAt: Timestamp.now(),
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
      limit(10)
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

  return {
    isProcessing,
    pendingCount,
  };
}
