"use client";

import { useState, useEffect, useCallback } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  limit,
  where,
  doc,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import {
  WorkerType,
  WorkerRun,
  WorkerTriggerContext,
} from "@/types/worker";

const MAX_WORKER_RUNS = 20;

interface TriggerWorkerOptions {
  workerType: WorkerType;
  initialPrompt: string;
  triggerContext?: WorkerTriggerContext;
  triggeredBy?: "auto" | "user";
}

export interface TriggerWorkerResult {
  runId: string;
  status: string;
  summary?: string;
  error?: string;
  sessionId?: string;
  deduped?: boolean;
}

/**
 * Hook for triggering and monitoring worker runs
 */
export function useWorker() {
  const { userId } = useAuth();
  const [isTriggering, setIsTriggering] = useState(false);

  /**
   * Trigger a worker run via the API
   */
  const triggerWorker = useCallback(
    async (options: TriggerWorkerOptions): Promise<TriggerWorkerResult> => {
      if (!userId) {
        throw new Error("User not authenticated");
      }

      setIsTriggering(true);

      try {
        // Get fresh ID token
        const auth = getAuth();
        const idToken = await auth.currentUser?.getIdToken();

        const response = await fetch("/api/worker", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idToken && { Authorization: `Bearer ${idToken}` }),
          },
          body: JSON.stringify(options),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Worker trigger failed");
        }

        return await response.json();
      } finally {
        setIsTriggering(false);
      }
    },
    [userId]
  );

  /**
   * Trigger a file matching worker with full file context
   */
  const triggerFileMatching = useCallback(
    async (
      fileId: string,
      fileInfo: {
        fileName?: string;
        amount?: number;
        currency?: string;
        date?: string;
        partner?: string;
      }
    ) => {
      // Build amount string with currency
      const amountStr = fileInfo.amount
        ? `${(Math.abs(fileInfo.amount) / 100).toFixed(2)} ${fileInfo.currency || "EUR"}`
        : "unknown amount";

      // Add currency hint if non-EUR
      const currencyHint =
        fileInfo.currency && fileInfo.currency !== "EUR"
          ? `\nNote: File is in ${fileInfo.currency}. Search EUR transactions with ±15% amount range.`
          : "";

      // Build context-rich prompt
      const prompt = `Find matching transaction for file ID: ${fileId}
File: "${fileInfo.fileName || "Unknown"}"
Amount: ${amountStr}${fileInfo.date ? ` dated ${fileInfo.date}` : ""}${fileInfo.partner ? ` from "${fileInfo.partner}"` : ""}${currencyHint}`;

      return triggerWorker({
        workerType: "file_matching",
        initialPrompt: prompt,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker]
  );

  /**
   * Trigger a receipt search worker for a transaction
   */
  const triggerReceiptSearch = useCallback(
    async (transactionId: string) => {
      return triggerWorker({
        workerType: "receipt_search",
        initialPrompt: `Find receipt for transaction ${transactionId}`,
        triggerContext: { transactionId },
        triggeredBy: "user",
      });
    },
    [triggerWorker]
  );

  /**
   * Trigger a partner matching worker for a transaction
   */
  const triggerPartnerSearch = useCallback(
    async (transactionId: string) => {
      return triggerWorker({
        workerType: "partner_matching",
        initialPrompt: `Find partner for transaction ID: ${transactionId}`,
        triggerContext: { transactionId },
        triggeredBy: "user",
      });
    },
    [triggerWorker]
  );

  /**
   * Trigger a partner search worker for a file
   */
  const triggerFilePartnerSearch = useCallback(
    async (fileId: string) => {
      return triggerWorker({
        workerType: "file_partner_matching",
        initialPrompt: `Find partner for file ID: ${fileId}`,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker]
  );

  /**
   * Trigger a file-to-transaction matching worker
   */
  const triggerFileTransactionSearch = useCallback(
    async (
      fileId: string,
      fileInfo?: {
        fileName?: string;
        amount?: number;
        currency?: string;
        date?: string;
        partner?: string;
      }
    ) => {
      // Build amount string with currency
      const amountStr = fileInfo?.amount
        ? `${(Math.abs(fileInfo.amount) / 100).toFixed(2)} ${fileInfo.currency || "EUR"}`
        : "unknown amount";

      // Add currency hint if non-EUR
      const currencyHint =
        fileInfo?.currency && fileInfo.currency !== "EUR"
          ? `\nNote: File is in ${fileInfo.currency}. Search EUR transactions with ±15% amount range.`
          : "";

      const prompt = `Find matching transaction for file ID: ${fileId}
File: "${fileInfo?.fileName || "Unknown"}"
Amount: ${amountStr}${fileInfo?.date ? ` dated ${fileInfo.date}` : ""}${fileInfo?.partner ? ` from "${fileInfo.partner}"` : ""}${currencyHint}`;

      return triggerWorker({
        workerType: "file_matching",
        initialPrompt: prompt,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker]
  );

  return {
    triggerWorker,
    triggerFileMatching,
    triggerReceiptSearch,
    triggerPartnerSearch,
    triggerFilePartnerSearch,
    triggerFileTransactionSearch,
    isTriggering,
  };
}

/**
 * Hook for fetching a specific worker run
 */
export function useWorkerRun(runId: string | null) {
  const { userId } = useAuth();
  const [workerRun, setWorkerRun] = useState<WorkerRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !runId) {
      setWorkerRun(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    const runRef = doc(db, `users/${userId}/workerRuns`, runId);

    const unsubscribe = onSnapshot(
      runRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setWorkerRun({
            id: snapshot.id,
            ...snapshot.data(),
          } as WorkerRun);
        } else {
          setWorkerRun(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching worker run:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId, runId]);

  return { workerRun, loading, error };
}

/**
 * Hook for listing recent worker runs
 */
export function useWorkerRuns(workerType?: WorkerType) {
  const { userId } = useAuth();
  const [workerRuns, setWorkerRuns] = useState<WorkerRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setWorkerRuns([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const runsPath = `users/${userId}/workerRuns`;
    let q = query(
      collection(db, runsPath),
      orderBy("createdAt", "desc"),
      limit(MAX_WORKER_RUNS)
    );

    // Filter by worker type if specified
    if (workerType) {
      q = query(
        collection(db, runsPath),
        where("workerType", "==", workerType),
        orderBy("createdAt", "desc"),
        limit(MAX_WORKER_RUNS)
      );
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as WorkerRun[];

        setWorkerRuns(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching worker runs:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId, workerType]);

  return { workerRuns, loading, error };
}

/**
 * Hook for listing active (running) worker runs
 */
export function useActiveWorkerRuns() {
  const { userId } = useAuth();
  const [activeRuns, setActiveRuns] = useState<WorkerRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setActiveRuns([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const runsPath = `users/${userId}/workerRuns`;
    const q = query(
      collection(db, runsPath),
      where("status", "in", ["pending", "running"]),
      orderBy("createdAt", "desc"),
      limit(10)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as WorkerRun[];

        setActiveRuns(data);
        setLoading(false);
      },
      (err) => {
        // This query might fail if the index doesn't exist yet
        console.error("Error fetching active worker runs:", err);
        setActiveRuns([]);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  return { activeRuns, loading };
}
