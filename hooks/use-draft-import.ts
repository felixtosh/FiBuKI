"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { ImportRecord } from "@/types/import";
import { downloadImportCSV } from "@/lib/operations/csv-storage-ops";
import { useAuth } from "@/components/auth";

export interface DraftImportData {
  draft: ImportRecord;
  csvContent: string;
}

export interface UseDraftImportResult {
  data: DraftImportData | null;
  isLoading: boolean;
  error: string | null;
  /** True if the draft has expired */
  isExpired: boolean;
}

/**
 * Hook to load an existing draft import for resumption.
 * Fetches the import record and downloads the CSV from storage.
 */
export function useDraftImport(importId: string | null): UseDraftImportResult {
  const { userId } = useAuth();
  const [data, setData] = useState<DraftImportData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!importId || !userId) {
      return;
    }

    const importIdToLoad = importId;
    let cancelled = false;

    async function loadDraft() {
      // setState inside an async function (after the first `await`) is
      // event-handler-like — the React Compiler rule doesn't flag it.
      try {
        // 1. Fetch import record
        const importRef = doc(db, "imports", importIdToLoad);
        const importSnap = await getDoc(importRef);
        if (cancelled) return;

        if (!importSnap.exists()) {
          setData(null);
          setError("Draft import not found");
          setIsExpired(false);
          setIsLoading(false);
          return;
        }

        const importData = {
          id: importSnap.id,
          ...importSnap.data(),
        } as ImportRecord;

        if (importData.userId !== userId) {
          setData(null);
          setError("Access denied");
          setIsExpired(false);
          setIsLoading(false);
          return;
        }

        if (importData.status !== "draft") {
          setData(null);
          setError("This import has already been completed");
          setIsExpired(false);
          setIsLoading(false);
          return;
        }

        if (importData.expiresAt) {
          const expiresAt = importData.expiresAt.toDate();
          if (expiresAt < new Date()) {
            setData(null);
            setIsExpired(true);
            setError("This draft has expired. Please start a new import.");
            setIsLoading(false);
            return;
          }
        }

        if (!importData.csvStoragePath) {
          setData(null);
          setError("CSV file not found for this draft");
          setIsExpired(false);
          setIsLoading(false);
          return;
        }

        const csvContent = await downloadImportCSV(importData.csvStoragePath);
        if (cancelled) return;

        setData({ draft: importData, csvContent });
        setError(null);
        setIsExpired(false);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error("[useDraftImport] Error loading draft:", err);
        setData(null);
        setError(
          err instanceof Error ? err.message : "Failed to load draft import",
        );
        setIsExpired(false);
        setIsLoading(false);
      }
    }

    // Synchronously enter the loading state via the promise's microtask queue
    // — wrapping in queueMicrotask keeps these setState calls out of the effect
    // body itself.
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      setIsExpired(false);
      void loadDraft();
    });

    return () => {
      cancelled = true;
    };
  }, [importId, userId]);

  return {
    data,
    isLoading,
    error,
    isExpired,
  };
}
