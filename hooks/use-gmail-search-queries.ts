"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import { Transaction } from "@/types/transaction";
import type { MailSearchTerms } from "@/functions/src/mail/provider";

/** Types of search suggestions - matches backend SuggestionType */
export type SuggestionType =
  | "invoice_number"  // Invoice/reference numbers (highest priority)
  | "company_name"    // Partner/company names
  | "email_domain"    // Email domains (from:domain)
  | "vat_id"          // VAT IDs
  | "iban"            // Bank account numbers
  | "pattern"         // File source patterns
  | "fallback";       // Generic search terms

export interface TypedSuggestion {
  /** The suggestion as text — the pill's label. May carry a Gmail operator. */
  query: string;
  type: SuggestionType;
  score: number;
  /**
   * The same suggestion in terms any mailbox can execute (#240). This, not
   * `query`, is what a search built from a pill sends.
   */
  terms: MailSearchTerms;
}

interface UseGmailSearchQueriesOptions {
  transaction?: Transaction | null;
  /** @deprecated Partner data is now fetched server-side using partnerId */
  partner?: unknown;
  /** Only generate queries when enabled (e.g., when overlay is open) */
  enabled?: boolean;
}

interface GenerateSearchQueriesRequest {
  /** Transaction ID for cache read/write */
  transactionId?: string;
  transaction: {
    name: string;
    partner?: string | null;
    description?: string;
    reference?: string;
    partnerId?: string | null;
    partnerType?: "global" | "user" | null;
  };
  maxQueries?: number;
}

interface GenerateSearchQueriesResponse {
  queries: string[];
  suggestions: TypedSuggestion[];
}

const generateSearchQueriesFn = httpsCallable<
  GenerateSearchQueriesRequest,
  GenerateSearchQueriesResponse
>(functions, "generateSearchQueriesCallable");

export function useGmailSearchQueries({
  transaction,
  enabled = true,
}: UseGmailSearchQueriesOptions = {}) {
  const [queries, setQueries] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<TypedSuggestion[]>([]);
  const [isPending, startTransition] = useTransition();
  const lastTransactionIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !transaction) {
      lastTransactionIdRef.current = null;
      return;
    }

    if (transaction.id === lastTransactionIdRef.current) {
      return;
    }

    lastTransactionIdRef.current = transaction.id;

    // Cancel any previous in-flight request.
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    startTransition(async () => {
      try {
        const result = await generateSearchQueriesFn({
          transactionId: transaction.id,
          transaction: {
            name: transaction.name ?? "",
            partner: transaction.partner,
            description: transaction.description ?? undefined,
            reference: transaction.reference ?? undefined,
            partnerId: transaction.partnerId,
            partnerType: transaction.partnerType,
          },
        });
        setQueries(result.data.queries);
        setSuggestions(result.data.suggestions ?? []);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "cancelled") return;
        console.error("Failed to generate search queries:", error);
        setQueries([]);
        setSuggestions([]);
      }
    });

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [transaction, enabled]);

  return {
    queries,
    suggestions,
    isLoading: isPending,
  };
}
