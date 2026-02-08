"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Supported banking providers
 */
export type BankingProvider = "finapi" | "truelayer" | "plaid" | "all";

/**
 * Generic institution type (works with finAPI, TrueLayer, etc.)
 */
export interface Institution {
  id: string;
  name: string;
  logo: string;
  countries: string[];
  bic?: string;
  transaction_total_days?: string;
  /** Which provider this institution is from */
  providerId?: "finapi" | "truelayer" | "plaid";
}

interface UseInstitutionsOptions {
  countryCode: string | null;
  /** Which provider to use. Defaults to "all" to query all available providers */
  provider?: BankingProvider;
}

interface UseInstitutionsReturn {
  institutions: Institution[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch and manage available financial institutions for a country
 *
 * Supports multiple providers:
 * - "truelayer" - Use TrueLayer only
 * - "finapi" - Use finAPI only
 * - "all" (default) - Query all configured providers and merge results
 */
export function useInstitutions({
  countryCode,
  provider = "all",
}: UseInstitutionsOptions): UseInstitutionsReturn {
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInstitutions = useCallback(async () => {
    if (!countryCode) {
      setInstitutions([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Use the unified banking API endpoint
      const params = new URLSearchParams({
        country: countryCode,
      });
      if (provider !== "all") {
        params.set("provider", provider);
      }

      const response = await fetch(`/api/banking/institutions?${params.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch institutions");
      }

      setInstitutions(data.institutions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch institutions");
      setInstitutions([]);
    } finally {
      setLoading(false);
    }
  }, [countryCode, provider]);

  useEffect(() => {
    fetchInstitutions();
  }, [fetchInstitutions]);

  return {
    institutions,
    loading,
    error,
    refetch: fetchInstitutions,
  };
}

/**
 * Filter institutions by search query
 */
export function filterInstitutions(
  institutions: Institution[],
  searchQuery: string
): Institution[] {
  if (!searchQuery.trim()) {
    return institutions;
  }

  const query = searchQuery.toLowerCase();
  return institutions.filter(
    (inst) =>
      inst.name.toLowerCase().includes(query) ||
      inst.bic?.toLowerCase().includes(query)
  );
}
