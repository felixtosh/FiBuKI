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
import { useAuth } from "@/components/auth";

export interface GmailSyncStatus {
  isActive: boolean;
  integrationEmail?: string;
  filesCreated?: number;
  emailsProcessed?: number;
  type?: "initial" | "scheduled" | "manual";
  startedAt?: Date;
}

type GmailSyncQueueDoc = {
  id: string;
  data: Record<string, unknown>;
};

function mapQueueDoc(doc: QueryDocumentSnapshot): GmailSyncQueueDoc {
  return { id: doc.id, data: doc.data() };
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Hook to monitor active Gmail sync status.
 * Returns sync info when a sync is in progress.
 */
export function useGmailSyncStatus(): GmailSyncStatus {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, "gmailSyncQueue"),
            where("userId", "==", userId),
            where("status", "in", ["pending", "processing"]),
            orderBy("createdAt", "desc"),
            limit(1),
          )
        : null,
    [userId],
  );

  const { data } = useFirestoreCollection(q, mapQueueDoc);
  // Capture "now" once per mount to avoid impure Date.now() calls during render.
  const [now] = useState(() => Date.now());

  return useMemo<GmailSyncStatus>(() => {
    if (data.length === 0) return { isActive: false };

    const queue = data[0];
    const queueData = queue.data as Record<string, unknown> & {
      createdAt?: { toDate(): Date };
      startedAt?: { toDate(): Date };
      status?: string;
      type?: "initial" | "scheduled" | "manual";
      filesCreated?: number;
      emailsProcessed?: number;
    };

    const createdAt = queueData.createdAt?.toDate();
    const isStale =
      createdAt &&
      queueData.status === "pending" &&
      now - createdAt.getTime() > STALE_THRESHOLD_MS;

    if (isStale) {
      console.log("[GmailSync] Found stale queue item, ignoring:", queue.id);
      return { isActive: false };
    }

    return {
      isActive: true,
      filesCreated: queueData.filesCreated ?? 0,
      emailsProcessed: queueData.emailsProcessed ?? 0,
      type: queueData.type,
      startedAt: queueData.startedAt?.toDate(),
    };
  }, [data, now]);
}

/**
 * Hook to get sync status for a specific integration.
 */
export function useIntegrationSyncStatus(integrationId: string | null): {
  isSyncing: boolean;
  filesCreated: number;
  emailsProcessed: number;
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

  return useMemo(() => {
    if (data.length === 0) {
      return { isSyncing: false, filesCreated: 0, emailsProcessed: 0 };
    }
    const queueData = data[0].data as {
      filesCreated?: number;
      emailsProcessed?: number;
    };
    return {
      isSyncing: true,
      filesCreated: queueData.filesCreated ?? 0,
      emailsProcessed: queueData.emailsProcessed ?? 0,
    };
  }, [data]);
}
