"use client";

import { useState, useCallback, useRef } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import {
  FindTransactionMatchesRequest,
  FindTransactionMatchesResponse,
  TransactionMatchResult,
  FileMatchingInfo,
  IneligibleReason,
} from "@/types/transaction-matching";

// Initialize the callable function
const findTransactionMatchesFn = httpsCallable<
  FindTransactionMatchesRequest,
  FindTransactionMatchesResponse
>(functions, "findTransactionMatchesForFile");

interface UseTransactionMatchingOptions {
  /** File ID to match against */
  fileId?: string;
  /** OR provide file info inline (for files not yet saved) */
  fileInfo?: FileMatchingInfo;
  /** Transaction IDs to exclude (already connected) */
  excludeTransactionIds?: string[];
  /** Max results to return */
  limit?: number;
}

interface UseTransactionMatchingResult {
  /** Matched transactions sorted by confidence */
  matches: TransactionMatchResult[];
  /** Total candidate transactions found */
  totalCandidates: number;
  /** Why the File is never matched, when it is not (#613). */
  ineligible: IneligibleReason | null;
  /** Loading state */
  isLoading: boolean;
  /** Error if fetch failed */
  error: Error | null;
  /** Fetch matches from server */
  fetchMatches: (searchQuery?: string) => Promise<void>;
  /** Clear current results */
  clearMatches: () => void;
}

export function useTransactionMatching({
  fileId,
  fileInfo,
  excludeTransactionIds = [],
  limit = 20,
}: UseTransactionMatchingOptions = {}): UseTransactionMatchingResult {
  const [matches, setMatches] = useState<TransactionMatchResult[]>([]);
  const [totalCandidates, setTotalCandidates] = useState(0);
  const [ineligible, setIneligible] = useState<IneligibleReason | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track the latest request to handle race conditions
  const requestIdRef = useRef(0);

  const fetchMatches = useCallback(
    async (searchQuery?: string) => {
      // Need either fileId or fileInfo
      if (!fileId && !fileInfo) {
        setMatches([]);
        setTotalCandidates(0);
        return;
      }

      // Increment request ID for this call
      const currentRequestId = ++requestIdRef.current;

      setIsLoading(true);
      setError(null);

      try {
        const result = await findTransactionMatchesFn({
          fileId,
          fileInfo,
          excludeTransactionIds,
          searchQuery: searchQuery || undefined,
          limit,
        });

        // Only update state if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setMatches(result.data.matches);
          setTotalCandidates(result.data.totalCandidates);
          setIneligible(result.data.ineligible ?? null);
        }
      } catch (err) {
        // Only update error state if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          const error =
            err instanceof Error ? err : new Error("Failed to fetch matches");
          console.error("[useTransactionMatching] Error:", error);
          setError(error);
          setMatches([]);
          setTotalCandidates(0);
        }
      } finally {
        // Only clear loading if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [fileId, fileInfo, excludeTransactionIds, limit]
  );

  const clearMatches = useCallback(() => {
    setMatches([]);
    setTotalCandidates(0);
    setError(null);
  }, []);

  return {
    matches,
    totalCandidates,
    ineligible,
    isLoading,
    error,
    fetchMatches,
    clearMatches,
  };
}
