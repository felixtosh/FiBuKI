"use client";

import { useState, useEffect, useCallback } from "react";
import { onSnapshot, doc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { TransactionSource } from "@/types/source";
import { TrueLayerApiConfig } from "@/types/truelayer";
import { FinapiBankingConfig } from "@/lib/banking/types";
import { useAuth } from "@/components/auth/auth-provider";

interface SyncStatus {
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  needsReauth: boolean;
  reauthExpiresAt: Date | null;
  reauthDaysRemaining: number | null;
}

type BankingProvider = "truelayer" | "finapi" | null;

interface UseSyncStatusReturn {
  status: SyncStatus | null;
  isSyncing: boolean;
  syncError: string | null;
  triggerSync: () => Promise<void>;
  isApiSource: boolean;
  provider: BankingProvider;
}

/**
 * Hook to monitor sync status for an API-connected source
 */
export function useSyncStatus(sourceId: string | null): UseSyncStatusReturn {
  const { user } = useAuth();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isApiSource, setIsApiSource] = useState(false);
  const [provider, setProvider] = useState<BankingProvider>(null);

  // Subscribe to source document for real-time updates
  useEffect(() => {
    if (!sourceId) {
      setStatus(null);
      setIsApiSource(false);
      setProvider(null);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, "sources", sourceId),
      (snapshot) => {
        if (!snapshot.exists()) {
          setStatus(null);
          setIsApiSource(false);
          setProvider(null);
          return;
        }

        const source = snapshot.data() as TransactionSource;

        if (source.type !== "api" || !source.apiConfig) {
          setIsApiSource(false);
          setStatus(null);
          setProvider(null);
          return;
        }

        setIsApiSource(true);

        const sourceProvider = source.apiConfig.provider as BankingProvider;
        setProvider(sourceProvider);

        if (sourceProvider === "finapi") {
          const config = source.apiConfig as unknown as FinapiBankingConfig;
          const expiresAt = config.expiresAt?.toDate() || null;
          const now = new Date();
          const daysRemaining = expiresAt
            ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
            : null;

          setStatus({
            lastSyncAt: config.lastSyncAt?.toDate() || null,
            lastSyncError: config.lastSyncError || null,
            needsReauth: expiresAt ? expiresAt < now : false,
            reauthExpiresAt: expiresAt,
            reauthDaysRemaining: daysRemaining,
          });
        } else if (sourceProvider === "truelayer") {
          const config = source.apiConfig as unknown as TrueLayerApiConfig;

          setStatus({
            lastSyncAt: config.lastSyncAt?.toDate() || null,
            lastSyncError: config.lastSyncError || null,
            needsReauth: false, // TrueLayer doesn't have same expiry concept
            reauthExpiresAt: null,
            reauthDaysRemaining: null,
          });
        } else {
          setStatus(null);
        }
      },
      (error) => {
        console.error("Error watching source:", error);
      }
    );

    return () => unsubscribe();
  }, [sourceId]);

  // Trigger manual sync
  const triggerSync = useCallback(async () => {
    if (!sourceId || !provider) return;

    setIsSyncing(true);
    setSyncError(null);

    try {
      // Use the right endpoint based on provider
      let endpoint: string;
      switch (provider) {
        case "finapi":
          endpoint = "/api/banking/sync";
          break;
        case "truelayer":
          endpoint = "/api/truelayer/sync";
          break;
        default:
          endpoint = "/api/banking/sync";
          break;
      }

      // Get auth token for finAPI endpoint
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider === "finapi" && user) {
        const token = await user.getIdToken();
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Sync failed");
      }

      // Success - status will update via onSnapshot
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setIsSyncing(false);
    }
  }, [sourceId, provider, user]);

  return {
    status,
    isSyncing,
    syncError,
    triggerSync,
    isApiSource,
    provider,
  };
}

/**
 * Format last sync time for display
 */
export function formatLastSync(date: Date | null): string {
  if (!date) return "Never synced";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString();
}

/**
 * Get sync status color for UI
 */
export function getSyncStatusColor(status: SyncStatus | null): "green" | "yellow" | "red" | "gray" {
  if (!status) return "gray";
  if (status.needsReauth) return "red";
  if (status.lastSyncError) return "yellow";
  if (status.lastSyncAt) return "green";
  return "gray";
}
