"use client";

import { useMemo } from "react";
import { collection, query, where, type QueryDocumentSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { IntegrationSyncStats } from "@/types/gmail-sync";
import { useAuth } from "@/components/auth";

type FileDoc = {
  extractionComplete?: boolean;
  extractionError?: unknown;
  partnerId?: string;
  extractedAmount?: number;
};

function mapFileDoc(doc: QueryDocumentSnapshot): FileDoc {
  return doc.data() as FileDoc;
}

/**
 * Stats over the Files a mailbox integration brought in. The receipt search
 * stamps each File with the integration it came from (`gmailIntegrationId`,
 * for IMAP too).
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
