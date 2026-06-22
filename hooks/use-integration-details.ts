"use client";

import { useMemo, useState } from "react";
import {
  collection,
  limit,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { GmailSyncHistoryRecord, IntegrationSyncStats } from "@/types/gmail-sync";
import { useAuth } from "@/components/auth";

function mapHistory(doc: QueryDocumentSnapshot): GmailSyncHistoryRecord {
  return { id: doc.id, ...doc.data() } as GmailSyncHistoryRecord;
}

type FileDoc = {
  extractionComplete?: boolean;
  extractionError?: unknown;
  partnerId?: string;
  extractedAmount?: number;
};

function mapFileDoc(doc: QueryDocumentSnapshot): FileDoc {
  return doc.data() as FileDoc;
}

type QueueDoc = {
  id: string;
  createdAt?: { toDate(): Date };
  status?: "pending" | "processing";
  filesCreated?: number;
  emailsProcessed?: number;
};

function mapQueueDoc(doc: QueryDocumentSnapshot): QueueDoc {
  return { id: doc.id, ...doc.data() } as QueueDoc;
}

/**
 * Hook to fetch sync history for an integration.
 */
export function useSyncHistory(
  integrationId: string | null,
  maxItems: number = 10,
) {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      integrationId && userId
        ? query(
            collection(db, "gmailSyncHistory"),
            where("integrationId", "==", integrationId),
            where("userId", "==", userId),
            orderBy("completedAt", "desc"),
            limit(maxItems),
          )
        : null,
    [integrationId, maxItems, userId],
  );

  const { data: history, loading } = useFirestoreCollection(q, mapHistory);

  return { history, loading };
}

/**
 * Hook to compute stats from files for an integration.
 */
export function useIntegrationFileStats(integrationId: string | null): {
  stats: IntegrationSyncStats | null;
  loading: boolean;
} {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      integrationId && userId
        ? query(
            collection(db, "files"),
            where("userId", "==", userId),
            where("gmailIntegrationId", "==", integrationId),
          )
        : null,
    [integrationId, userId],
  );

  const { data: files, loading } = useFirestoreCollection(q, mapFileDoc);

  const stats = useMemo<IntegrationSyncStats | null>(() => {
    if (!integrationId || !userId) return null;
    let totalFilesImported = 0;
    let filesExtracted = 0;
    let filesMatched = 0;
    let filesWithErrors = 0;
    let filesNotInvoices = 0;

    for (const data of files) {
      totalFilesImported++;
      if (data.extractionComplete) filesExtracted++;
      if (data.extractionError) filesWithErrors++;
      if (data.partnerId) filesMatched++;
      if (
        data.extractionComplete &&
        !data.extractedAmount &&
        !data.extractionError
      ) {
        filesNotInvoices++;
      }
    }

    return {
      totalFilesImported,
      filesExtracted,
      filesMatched,
      filesWithErrors,
      filesNotInvoices,
    };
  }, [files, integrationId, userId]);

  return { stats, loading };
}

/**
 * Hook to get active sync status for an integration.
 */
export function useActiveSyncForIntegration(integrationId: string | null): {
  isActive: boolean;
  filesCreated: number;
  emailsProcessed: number;
  status: "pending" | "processing" | null;
} {
  const q = useMemo(
    () =>
      integrationId
        ? query(
            collection(db, "gmailSyncQueue"),
            where("integrationId", "==", integrationId),
            where("status", "in", ["pending", "processing"]),
            limit(1),
          )
        : null,
    [integrationId],
  );

  const { data } = useFirestoreCollection(q, mapQueueDoc);
  // Capture "now" once per mount to keep render pure.
  const [now] = useState(() => Date.now());

  return useMemo(() => {
    if (data.length === 0) {
      return {
        isActive: false,
        filesCreated: 0,
        emailsProcessed: 0,
        status: null as "pending" | "processing" | null,
      };
    }

    const queue = data[0];
    const createdAt = queue.createdAt?.toDate();
    const isStale =
      createdAt &&
      queue.status === "pending" &&
      now - createdAt.getTime() > 10 * 60 * 1000;

    if (isStale) {
      return {
        isActive: false,
        filesCreated: 0,
        emailsProcessed: 0,
        status: null as "pending" | "processing" | null,
      };
    }

    return {
      isActive: true,
      filesCreated: queue.filesCreated ?? 0,
      emailsProcessed: queue.emailsProcessed ?? 0,
      status: queue.status ?? null,
    };
  }, [data, now]);
}
