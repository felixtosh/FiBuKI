"use client";

import { useState, useEffect, useCallback } from "react";
import { callFunction } from "@/lib/firebase/callable";

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  expiresAt: string | null;
}

interface CreateApiKeyResponse {
  id: string;
  key: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await callFunction<void, { keys: ApiKey[] }>("listApiKeys", undefined);
      setKeys(result.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const createKey = useCallback(
    async (name: string): Promise<CreateApiKeyResponse> => {
      const result = await callFunction<{ name: string }, CreateApiKeyResponse>("createApiKey", {
        name,
      });
      await fetchKeys();
      return result;
    },
    [fetchKeys]
  );

  const revokeKey = useCallback(
    async (keyId: string) => {
      await callFunction<{ keyId: string }, { success: boolean }>("revokeApiKey", { keyId });
      await fetchKeys();
    },
    [fetchKeys]
  );

  return {
    keys,
    loading,
    error,
    createKey,
    revokeKey,
    refresh: fetchKeys,
  };
}
