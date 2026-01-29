"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";
import { UserExport, UserExportRequest, UserExportResponse } from "@/types/user-export";

const MAX_EXPORTS = 10;

export function useUserExports() {
  const { userId } = useAuth();
  const [exports, setExports] = useState<UserExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [requesting, setRequesting] = useState(false);

  // Get current active export (pending or processing)
  const activeExport = useMemo(
    () => exports.find((e) => e.status === "pending" || e.status === "processing"),
    [exports]
  );

  // Get completed exports
  const completedExports = useMemo(
    () =>
      exports
        .filter((e) => e.status === "completed")
        .sort((a, b) => {
          const aTime = a.completedAt?.toMillis?.() || 0;
          const bTime = b.completedAt?.toMillis?.() || 0;
          return bTime - aTime;
        }),
    [exports]
  );

  // Real-time listener for exports
  useEffect(() => {
    if (!userId) {
      setExports([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, "userExports"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
      limit(MAX_EXPORTS)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as UserExport[];

        setExports(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching exports:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Request a new export
  const requestExport = useCallback(
    async (includeStorageFiles: boolean = false): Promise<string | null> => {
      if (!userId) return null;

      setRequesting(true);
      setError(null);

      try {
        const result = await callFunction<UserExportRequest, UserExportResponse>(
          "requestUserExport",
          { includeStorageFiles }
        );

        if (result.success) {
          return result.exportId;
        }
        return null;
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Export request failed");
        setError(error);
        return null;
      } finally {
        setRequesting(false);
      }
    },
    [userId]
  );

  // Check if an export is expired
  const isExpired = useCallback((exportItem: UserExport): boolean => {
    if (!exportItem.expiresAt) return false;
    const expiresAt = exportItem.expiresAt.toMillis?.() || 0;
    return Date.now() > expiresAt;
  }, []);

  // Format file size
  const formatSize = useCallback((bytes?: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  // Get days until expiry
  const getDaysUntilExpiry = useCallback((exportItem: UserExport): number => {
    if (!exportItem.expiresAt) return 0;
    const expiresAt = exportItem.expiresAt.toMillis?.() || 0;
    const diff = expiresAt - Date.now();
    return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }, []);

  return {
    exports,
    activeExport,
    completedExports,
    loading,
    error,
    requesting,
    requestExport,
    isExpired,
    formatSize,
    getDaysUntilExpiry,
  };
}
