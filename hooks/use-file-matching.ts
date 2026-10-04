"use client";

import { useState, useCallback, useRef } from "react";
import { callFunction } from "@/lib/firebase/callable";
import {
  FindFileMatchesRequest,
  FindFileMatchesResponse,
  FileMatchResult,
} from "@/types/transaction-matching";

/**
 * The matcher's Confidence for the user's Files against one Transaction
 * (#555), from findFileMatchesForTransaction. The mirror of
 * useTransactionMatching: the server reads the Transaction and every File
 * itself, so nothing here is a scoring input.
 */
export function useFileMatching({
  transactionId,
  limit = 50,
}: {
  transactionId?: string | null;
  limit?: number;
}) {
  const [matches, setMatches] = useState<FileMatchResult[]>([]);
  /**
   * Files the matcher holds back from this Transaction because a Rejection
   * names the pair (#613). From the last unsearched answer: a search shows
   * them, so it does not overwrite the list it hides them from.
   */
  const [rejectedFileIds, setRejectedFileIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [isLoading, setIsLoading] = useState(false);
  /** Set once a response for the current Transaction has arrived. */
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Only the latest request may write state.
  const requestIdRef = useRef(0);

  const fetchMatches = useCallback(
    async (searchQuery?: string) => {
      const currentRequestId = ++requestIdRef.current;
      if (!transactionId) {
        setMatches([]);
        setRejectedFileIds(EMPTY_IDS);
        setHasLoaded(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const result = await callFunction<FindFileMatchesRequest, FindFileMatchesResponse>(
          "findFileMatchesForTransaction",
          { transactionId, searchQuery: searchQuery?.trim() || undefined, limit }
        );
        if (currentRequestId === requestIdRef.current) {
          setMatches(result.matches);
          if (!searchQuery?.trim()) setRejectedFileIds(new Set(result.rejectedFileIds ?? []));
          setHasLoaded(true);
        }
      } catch (err) {
        if (currentRequestId === requestIdRef.current) {
          const failure = err instanceof Error ? err : new Error("Failed to fetch matches");
          console.error("[useFileMatching] Error:", failure);
          setError(failure);
          setMatches([]);
          // A failed ranking still lets the list render, unscored.
          setHasLoaded(true);
        }
      } finally {
        if (currentRequestId === requestIdRef.current) setIsLoading(false);
      }
    },
    [transactionId, limit]
  );

  const clearMatches = useCallback(() => {
    requestIdRef.current++;
    setMatches([]);
    setRejectedFileIds(EMPTY_IDS);
    setHasLoaded(false);
    setError(null);
    setIsLoading(false);
  }, []);

  return { matches, rejectedFileIds, isLoading, hasLoaded, error, fetchMatches, clearMatches };
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
