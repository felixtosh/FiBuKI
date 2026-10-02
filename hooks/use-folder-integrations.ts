"use client";

import { useState, useEffect, useCallback } from "react";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import { callFunction } from "@/lib/firebase/callable";
import type { FolderIntegration, FolderProvider } from "@/types/folder-integration";

export interface FolderChoice {
  name: string;
  path: string;
}

export interface FolderSyncSummary {
  skipped?: string;
  imported?: number;
  duplicates?: number;
  unsupported?: number;
  failed?: number;
  marked?: number;
  deleted?: number;
  restored?: number;
  paused?: boolean;
  pendingRemovals?: number;
}

/** The user's Folder Integrations of one provider, live, and what can be done to them. */
export function useFolderIntegrations(provider: FolderProvider) {
  const { userId } = useAuth();
  const [integrations, setIntegrations] = useState<FolderIntegration[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    const q = query(collection(db, "folderIntegrations"), where("userId", "==", userId));
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }) as FolderIntegration)
          .filter((i) => i.provider === provider && i.isActive);
        setIntegrations(rows);
        setLoading(false);
      },
      () => setLoading(false)
    );
  }, [userId, provider]);

  const connect = useCallback(async () => {
    const res = await fetchWithAuth(`/api/${provider}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to start authorization");
    }
    const { url } = await res.json();
    window.location.href = url;
  }, [provider]);

  const listFolders = useCallback(
    (integrationId: string, path: string) =>
      callFunction<{ integrationId: string; path: string }, { folders: FolderChoice[] }>(
        "listFolderChoices",
        { integrationId, path }
      ),
    []
  );

  const setFolder = useCallback(
    (integrationId: string, path: string) =>
      callFunction<{ integrationId: string; path: string }, { sync: FolderSyncSummary }>(
        "setFolderIntegrationFolder",
        { integrationId, path }
      ),
    []
  );

  const setRemoveConnected = useCallback(
    (integrationId: string, removeConnectedFiles: boolean) =>
      callFunction("updateFolderIntegrationSettings", { integrationId, removeConnectedFiles }),
    []
  );

  const syncNow = useCallback(
    (integrationId: string, approveRemovals = false) =>
      callFunction<{ integrationId: string; approveRemovals: boolean }, { sync: FolderSyncSummary }>(
        "syncFolderIntegration",
        { integrationId, approveRemovals }
      ),
    []
  );

  const disconnect = useCallback(
    (integrationId: string) => callFunction("disconnectFolderIntegration", { integrationId }),
    []
  );

  // Signed out: nothing to show, and nothing left to wait for.
  return {
    integrations: userId ? integrations : [],
    loading: userId ? loading : false,
    connect,
    listFolders,
    setFolder,
    setRemoveConnected,
    syncNow,
    disconnect,
  };
}
