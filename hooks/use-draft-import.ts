"use client";

import { useState, useEffect } from "react";
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
 *
 * @param importId - The import ID to load (from URL param)
 * @returns Draft data, loading state, and error
 */
export function useDraftImport(importId: string | null): UseDraftImportResult {
  const { userId } = useAuth();
  const [data, setData] = useState<DraftImportData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!importId || !userId) {
      setData(null);
      setIsLoading(false);
      setError(null);
      setIsExpired(false);
      return;
    }

    // Capture importId in closure to satisfy TypeScript
    const importIdToLoad = importId;

    let cancelled = false;

    async function loadDraft() {
      setIsLoading(true);
      setError(null);
      setIsExpired(false);

      try {
        // 1. Fetch import record
        const importRef = doc(db, "imports", importIdToLoad);
        const importSnap = await getDoc(importRef);

        if (cancelled) return;

        if (!importSnap.exists()) {
          setError("Draft import not found");
          setIsLoading(false);
          return;
        }

        const importData = {
          id: importSnap.id,
          ...importSnap.data(),
        } as ImportRecord;

        // 2. Verify ownership
        if (importData.userId !== userId) {
          setError("Access denied");
          setIsLoading(false);
          return;
        }

        // 3. Check if it's still a draft
        if (importData.status !== "draft") {
          // Not an error - just means import was already completed
          // This can happen if user completes import in another tab
          setError("This import has already been completed");
          setIsLoading(false);
          return;
        }

        // 4. Check expiration
        if (importData.expiresAt) {
          const expiresAt = importData.expiresAt.toDate();
          if (expiresAt < new Date()) {
            setIsExpired(true);
            setError("This draft has expired. Please start a new import.");
            setIsLoading(false);
            return;
          }
        }

        // 5. Download CSV from storage
        if (!importData.csvStoragePath) {
          setError("CSV file not found for this draft");
          setIsLoading(false);
          return;
        }

        const csvContent = await downloadImportCSV(importData.csvStoragePath);

        if (cancelled) return;

        setData({
          draft: importData,
          csvContent,
        });
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;

        console.error("[useDraftImport] Error loading draft:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load draft import"
        );
        setIsLoading(false);
      }
    }

    loadDraft();

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
