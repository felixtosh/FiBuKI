"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import {
  CreateInboundEmailAddressData,
  InboundEmailAddress,
  InboundEmailLog,
  UpdateInboundEmailAddressData,
} from "@/types/email-inbound";
import { useAuth } from "@/components/auth";
import { callFunction } from "@/lib/firebase/callable";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";

const ADDRESSES_COLLECTION = "inboundEmailAddresses";
const LOGS_COLLECTION = "inboundEmailLogs";

function mapAddress(doc: QueryDocumentSnapshot): InboundEmailAddress {
  return { id: doc.id, ...doc.data() } as InboundEmailAddress;
}

function mapLog(doc: QueryDocumentSnapshot): InboundEmailLog {
  return { id: doc.id, ...doc.data() } as InboundEmailLog;
}

export interface UseEmailInboundResult {
  /** List of inbound email addresses */
  addresses: InboundEmailAddress[];
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Update an inbound email address */
  updateAddress: (
    addressId: string,
    updates: UpdateInboundEmailAddressData,
  ) => Promise<void>;
  /** Regenerate email address (creates new, deactivates old) */
  regenerateAddress: (
    addressId: string,
  ) => Promise<{ id: string; email: string }>;
  /** Delete (deactivate) an inbound email address */
  deleteAddress: (addressId: string) => Promise<void>;
  /** Pause an inbound email address */
  pauseAddress: (addressId: string) => Promise<void>;
  /** Resume an inbound email address */
  resumeAddress: (addressId: string) => Promise<void>;
  /** Check if user has any inbound address configured */
  hasInboundAddress: boolean;
  /** Get the primary (first active) address */
  primaryAddress: InboundEmailAddress | null;
}

export function useEmailInbound(): UseEmailInboundResult {
  const { userId } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, ADDRESSES_COLLECTION),
            where("userId", "==", userId),
            orderBy("createdAt", "desc"),
          )
        : null,
    [userId],
  );

  const { data: addresses, loading } = useFirestoreCollection(q, mapAddress);

  // Auto-create an inbound address if none exist. This runs outside the
  // subscription effect so the subscription itself stays setState-free.
  useEffect(() => {
    if (!userId || loading || addresses.length > 0 || creatingRef.current) return;
    creatingRef.current = true;
    void (async () => {
      try {
        console.log("[useEmailInbound] Auto-creating inbound email address");
        await callFunction<CreateInboundEmailAddressData, { id: string; email: string }>(
          "createInboundEmailAddress",
          {},
        );
      } catch (err) {
        console.error("[useEmailInbound] Failed to auto-create address:", err);
        setError(err instanceof Error ? err.message : "Failed to create address");
      } finally {
        creatingRef.current = false;
      }
    })();
  }, [userId, loading, addresses.length]);

  const updateAddress = useCallback(
    async (addressId: string, updates: UpdateInboundEmailAddressData) => {
      if (!userId) throw new Error("Not authenticated");
      try {
        setError(null);
        await callFunction<
          { addressId: string; data: UpdateInboundEmailAddressData },
          { success: boolean }
        >("updateInboundEmailAddress", { addressId, data: updates });
      } catch (err) {
        console.error("Failed to update inbound address:", err);
        const message =
          err instanceof Error ? err.message : "Failed to update address";
        setError(message);
        throw err;
      }
    },
    [userId],
  );

  const regenerateAddress = useCallback(
    async (addressId: string) => {
      if (!userId) throw new Error("Not authenticated");
      try {
        setError(null);
        return await callFunction<{ addressId: string }, { id: string; email: string }>(
          "regenerateInboundEmailAddress",
          { addressId },
        );
      } catch (err) {
        console.error("Failed to regenerate inbound address:", err);
        const message =
          err instanceof Error ? err.message : "Failed to regenerate address";
        setError(message);
        throw err;
      }
    },
    [userId],
  );

  const deleteAddress = useCallback(
    async (addressId: string) => {
      if (!userId) throw new Error("Not authenticated");
      try {
        setError(null);
        await callFunction<{ addressId: string }, { success: boolean }>(
          "deleteInboundEmailAddress",
          { addressId },
        );
      } catch (err) {
        console.error("Failed to delete inbound address:", err);
        const message =
          err instanceof Error ? err.message : "Failed to delete address";
        setError(message);
        throw err;
      }
    },
    [userId],
  );

  const pauseAddress = useCallback(
    async (addressId: string) => {
      await updateAddress(addressId, { isActive: false });
    },
    [updateAddress],
  );

  const resumeAddress = useCallback(
    async (addressId: string) => {
      await updateAddress(addressId, { isActive: true });
    },
    [updateAddress],
  );

  const hasInboundAddress = useMemo(
    () => addresses.some((a) => a.isActive),
    [addresses],
  );

  const primaryAddress = useMemo(
    () => addresses.find((a) => a.isActive) || addresses[0] || null,
    [addresses],
  );

  return {
    addresses,
    loading,
    error,
    updateAddress,
    regenerateAddress,
    deleteAddress,
    pauseAddress,
    resumeAddress,
    hasInboundAddress,
    primaryAddress,
  };
}

/**
 * Hook to fetch logs for an inbound email address.
 */
export interface UseInboundEmailLogsResult {
  logs: InboundEmailLog[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useInboundEmailLogs(
  addressId: string | null,
): UseInboundEmailLogsResult {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      addressId && userId
        ? query(
            collection(db, LOGS_COLLECTION),
            where("userId", "==", userId),
            where("inboundAddressId", "==", addressId),
            orderBy("receivedAt", "desc"),
          )
        : null,
    [addressId, userId],
  );

  const { data: logs, loading, error } = useFirestoreCollection(q, mapLog);

  // No-op kept for API compatibility — onSnapshot already streams updates.
  const refresh = useCallback(() => {}, []);

  return {
    logs,
    loading,
    error: error?.message ?? null,
    refresh,
  };
}
