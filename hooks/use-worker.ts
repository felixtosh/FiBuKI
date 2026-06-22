"use client";

import { useCallback, useMemo, useState } from "react";
import {
  collection,
  doc,
  limit,
  orderBy,
  query,
  where,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import {
  useFirestoreCollection,
  useFirestoreDoc,
} from "@/lib/firebase/use-firestore-collection";
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

function mapWorkerRun(snap: QueryDocumentSnapshot): WorkerRun {
  return { id: snap.id, ...snap.data() } as WorkerRun;
}

function mapWorkerRunDoc(snap: DocumentSnapshot): WorkerRun | null {
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as WorkerRun;
}

/**
 * Hook for triggering and monitoring worker runs.
 */
export function useWorker() {
  const { userId } = useAuth();
  const [isTriggering, setIsTriggering] = useState(false);

  const triggerWorker = useCallback(
    async (options: TriggerWorkerOptions): Promise<TriggerWorkerResult> => {
      if (!userId) {
        throw new Error("User not authenticated");
      }

      setIsTriggering(true);

      try {
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
    [userId],
  );

  const triggerFileMatching = useCallback(
    async (
      fileId: string,
      fileInfo: {
        fileName?: string;
        amount?: number;
        currency?: string;
        date?: string;
        partner?: string;
      },
    ) => {
      const amountStr = fileInfo.amount
        ? `${(Math.abs(fileInfo.amount) / 100).toFixed(2)} ${
            fileInfo.currency || "EUR"
          }`
        : "unknown amount";

      const currencyHint =
        fileInfo.currency && fileInfo.currency !== "EUR"
          ? `\nNote: File is in ${fileInfo.currency}. Search EUR transactions with ±15% amount range.`
          : "";

      const prompt = `Find matching transaction for file ID: ${fileId}
File: "${fileInfo.fileName || "Unknown"}"
Amount: ${amountStr}${
        fileInfo.date ? ` dated ${fileInfo.date}` : ""
      }${fileInfo.partner ? ` from "${fileInfo.partner}"` : ""}${currencyHint}`;

      return triggerWorker({
        workerType: "file_matching",
        initialPrompt: prompt,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker],
  );

  const triggerReceiptSearch = useCallback(
    async (transactionId: string) => {
      return triggerWorker({
        workerType: "receipt_search",
        initialPrompt: `Find receipt for transaction ${transactionId}`,
        triggerContext: { transactionId },
        triggeredBy: "user",
      });
    },
    [triggerWorker],
  );

  const triggerPartnerSearch = useCallback(
    async (transactionId: string) => {
      return triggerWorker({
        workerType: "partner_matching",
        initialPrompt: `Find partner for transaction ID: ${transactionId}`,
        triggerContext: { transactionId },
        triggeredBy: "user",
      });
    },
    [triggerWorker],
  );

  const triggerFilePartnerSearch = useCallback(
    async (fileId: string) => {
      return triggerWorker({
        workerType: "file_partner_matching",
        initialPrompt: `Find partner for file ID: ${fileId}`,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker],
  );

  const triggerFileTransactionSearch = useCallback(
    async (
      fileId: string,
      fileInfo?: {
        fileName?: string;
        amount?: number;
        currency?: string;
        date?: string;
        partner?: string;
      },
    ) => {
      const amountStr = fileInfo?.amount
        ? `${(Math.abs(fileInfo.amount) / 100).toFixed(2)} ${
            fileInfo.currency || "EUR"
          }`
        : "unknown amount";

      const currencyHint =
        fileInfo?.currency && fileInfo.currency !== "EUR"
          ? `\nNote: File is in ${fileInfo.currency}. Search EUR transactions with ±15% amount range.`
          : "";

      const prompt = `Find matching transaction for file ID: ${fileId}
File: "${fileInfo?.fileName || "Unknown"}"
Amount: ${amountStr}${
        fileInfo?.date ? ` dated ${fileInfo.date}` : ""
      }${fileInfo?.partner ? ` from "${fileInfo.partner}"` : ""}${currencyHint}`;

      return triggerWorker({
        workerType: "file_matching",
        initialPrompt: prompt,
        triggerContext: { fileId },
        triggeredBy: "user",
      });
    },
    [triggerWorker],
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
 * Hook for fetching a specific worker run.
 */
export function useWorkerRun(runId: string | null) {
  const { userId } = useAuth();

  const ref = useMemo(
    () =>
      userId && runId ? doc(db, `users/${userId}/workerRuns`, runId) : null,
    [userId, runId],
  );

  const { data: workerRun, loading, error } = useFirestoreDoc(
    ref,
    mapWorkerRunDoc,
  );

  return { workerRun, loading, error };
}

/**
 * Hook for listing recent worker runs.
 */
export function useWorkerRuns(workerType?: WorkerType) {
  const { userId } = useAuth();

  const q = useMemo(() => {
    if (!userId) return null;
    const runsPath = `users/${userId}/workerRuns`;
    if (workerType) {
      return query(
        collection(db, runsPath),
        where("workerType", "==", workerType),
        orderBy("createdAt", "desc"),
        limit(MAX_WORKER_RUNS),
      );
    }
    return query(
      collection(db, runsPath),
      orderBy("createdAt", "desc"),
      limit(MAX_WORKER_RUNS),
    );
  }, [userId, workerType]);

  const { data: workerRuns, loading, error } = useFirestoreCollection(
    q,
    mapWorkerRun,
  );

  return { workerRuns, loading, error };
}

/**
 * Hook for listing active (running) worker runs.
 */
export function useActiveWorkerRuns() {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, `users/${userId}/workerRuns`),
            where("status", "in", ["pending", "running"]),
            orderBy("createdAt", "desc"),
            limit(10),
          )
        : null,
    [userId],
  );

  const { data: activeRuns, loading } = useFirestoreCollection(q, mapWorkerRun);

  return { activeRuns, loading };
}
